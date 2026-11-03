// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.fakedaemon

import com.evenseal.usagedeck.core.daemon.DaemonEvent
import com.evenseal.usagedeck.core.daemon.DaemonEventSource
import com.evenseal.usagedeck.core.daemon.DaemonException
import com.evenseal.usagedeck.core.daemon.OkHttpDaemonApi
import com.evenseal.usagedeck.core.daemon.SessionsResult
import com.evenseal.usagedeck.core.pairing.PairingClient
import com.evenseal.usagedeck.core.pairing.PairingInvite
import java.net.BindException
import java.net.ServerSocket
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class FakeDaemonTest {
    private val json = "application/json".toMediaType()
    private val client = OkHttpClient.Builder()
        .readTimeout(10, TimeUnit.SECONDS)
        .callTimeout(15, TimeUnit.SECONDS)
        .build()
    private var port = 0
    private lateinit var daemon: FakeDaemon

    // A free port found by closing a ServerSocket can be taken by something else before the
    // daemon binds it (it was, once, on a CI runner), so a lost race picks another port.
    @Before
    fun up() {
        repeat(5) { attempt ->
            port = ServerSocket(0).use { it.localPort }
            daemon = FakeDaemon(port = port)
            try {
                daemon.start()
                return
            } catch (e: Exception) {
                runCatching { daemon.stop() }
                if (!generateSequence<Throwable>(e) { it.cause }.any { it is BindException } || attempt == 4) throw e
            }
        }
    }

    @After
    fun down() {
        daemon.stop()
    }

    private fun url(path: String) = "http://127.0.0.1:$port$path"

    private fun get(path: String, etag: String? = null, token: String? = daemon.token): Response {
        val builder = Request.Builder().url(url(path)).get()
        etag?.let { builder.header("If-None-Match", it) }
        token?.let { builder.header("Authorization", "Bearer $it") }
        return client.newCall(builder.build()).execute()
    }

    private fun post(path: String, body: String, token: String? = daemon.token): Response {
        val builder = Request.Builder().url(url(path)).post(body.toRequestBody(json))
        token?.let { builder.header("Authorization", "Bearer $it") }
        return client.newCall(builder.build()).execute()
    }

    private fun delete(path: String, token: String? = daemon.token): Response {
        val builder = Request.Builder().url(url(path)).delete()
        token?.let { builder.header("Authorization", "Bearer $it") }
        return client.newCall(builder.build()).execute()
    }

    @Test
    fun `health reports name version user and update`() {
        get("/health").use { r ->
            assertEquals(200, r.code)
            val body = r.body.string()
            assertTrue(body.contains("\"name\":\"fake-mbp\""))
            assertTrue(body.contains("\"version\""))
            assertTrue(body.contains("\"user\""))
            assertTrue(body.contains("\"update\""))
        }
    }

    @Test
    fun `summary nests the limits body and carries a status map`() {
        get("/v1/summary").use { r ->
            val body = r.body.string()
            assertTrue(body.contains("\"limits\":{"))
            assertTrue(body.contains("\"weekly_all\""))
            assertTrue(body.contains("\"status\":{"))
            assertTrue(body.contains("\"thresholds\":{"))
        }
    }

    @Test
    fun `sessions carries a weak etag and answers 304 when it matches`() {
        val etag = get("/v1/sessions").use { r ->
            assertEquals(200, r.code)
            assertEquals(4, Regex("\"sessionId\"").findAll(r.body.string()).count())
            r.header("ETag")
        }
        assertNotNull(etag)
        get("/v1/sessions", etag = etag).use { r -> assertEquals(304, r.code) }
    }

    @Test
    fun `tokens only answers groupBy project`() {
        get("/v1/tokens?since=today&groupBy=project").use { r ->
            assertEquals(200, r.code)
            assertTrue(r.body.string().contains("\"groups\""))
        }
        get("/v1/tokens?since=today&groupBy=model").use { r -> assertEquals(400, r.code) }
    }

    @Test
    fun `a mutating request without the token is refused with the error envelope`() {
        post("/v1/pause", """{"scope":"all","mode":"soft","reason":"x"}""", token = null).use { r ->
            assertEquals(401, r.code)
            val body = r.body.string()
            assertTrue(body.contains("\"code\":\"unauthorized\""))
            assertTrue(body.contains("\"message\""))
        }
    }

    @Test
    fun `a mutating request with the wrong token is refused`() {
        post("/v1/pause", """{"scope":"all","mode":"soft","reason":"x"}""", token = "nope").use { r ->
            assertEquals(401, r.code)
        }
    }

    @Test
    fun `pause is idempotent and returns the same rule twice`() {
        val first = post("/v1/pause", """{"scope":"all","mode":"soft","reason":"usage-deck:t"}""").use { r ->
            assertEquals(200, r.code)
            r.body.string()
        }
        val id = Regex("\"id\":\"([^\"]+)\"").find(first)!!.groupValues[1]
        val second = post("/v1/pause", """{"scope":"all","mode":"soft","reason":"usage-deck:t"}""").use { r ->
            assertEquals(200, r.code)
            r.body.string()
        }
        assertEquals(id, Regex("\"id\":\"([^\"]+)\"").find(second)!!.groupValues[1])
        assertEquals(1, daemon.state.rules.size)

        get("/v1/pause/rules").use { r ->
            assertEquals(200, r.code)
            assertTrue(r.body.string().contains("usage-deck:t"))
        }
    }

    @Test
    fun `a soft pause marks its sessions paused and resume clears them`() {
        post("/v1/pause", """{"scope":"all","mode":"soft","reason":"usage-deck:t"}""").use { r ->
            assertTrue(r.body.string().contains("\"affected\""))
        }
        assertTrue(daemon.state.sessions.all { it.pause != null })

        post("/v1/resume", """{"scope":"all"}""").use { r ->
            assertEquals(200, r.code)
            assertTrue(r.body.string().contains("\"removed\""))
        }
        assertTrue(daemon.state.sessions.all { it.pause == null })
        assertTrue(daemon.state.rules.isEmpty())
    }

    @Test
    fun `resume with nothing to remove is still a 200 with empty arrays`() {
        post("/v1/resume", """{"scope":"session:nope"}""").use { r ->
            assertEquals(200, r.code)
            assertEquals("""{"removed":[],"resumed":[]}""", r.body.string())
        }
    }

    @Test
    fun `hard pause on a transcript-discovered session is a 409`() {
        val transcript = daemon.state.sessions.first { it.discovered == "transcript" && it.alive }
        post("/v1/pause", """{"scope":"session:${transcript.sessionId}","mode":"hard","reason":"x"}""").use { r ->
            assertEquals(409, r.code)
            assertTrue(r.body.string().contains("\"code\":\"conflict\""))
        }
        assertTrue("no rule is created for a refused hard pause", daemon.state.rules.isEmpty())

        // the same session accepts a soft pause
        post("/v1/pause", """{"scope":"session:${transcript.sessionId}","mode":"soft","reason":"x"}""").use { r ->
            assertEquals(200, r.code)
        }
    }

    @Test
    fun `pause on an unknown or exited session is a 410 and creates no rule`() {
        post("/v1/pause", """{"scope":"session:nope","mode":"soft","reason":"x"}""").use { r ->
            assertEquals(410, r.code)
            assertTrue(r.body.string().contains("\"code\":\"gone\""))
        }
        val dead = daemon.state.sessions.first { !it.alive }
        post("/v1/pause", """{"scope":"session:${dead.sessionId}","mode":"soft","reason":"x"}""").use { r ->
            assertEquals(410, r.code)
        }
        assertTrue(daemon.state.rules.isEmpty())
    }

    @Test
    fun `rev moves on pause and resume but never on a limits change`() {
        val start = daemon.state.rev
        val d = daemon
        Scenarios.warnCrossing.init(d.state)
        repeat(3) { Scenarios.warnCrossing.step(d.state, it + 1) { _, _ -> } }
        assertEquals("limits never move the sessions revision", start, d.state.rev)

        post("/v1/pause", """{"scope":"all","mode":"soft","reason":"x"}""").use { r -> assertEquals(200, r.code) }
        val afterPause = daemon.state.rev
        assertTrue(afterPause > start)
        post("/v1/resume", """{"scope":"all"}""").use { r -> assertEquals(200, r.code) }
        assertTrue(daemon.state.rev > afterPause)
    }

    @Test
    fun `deleting a rule by id removes it and an unknown id is a 404`() {
        val body = post("/v1/pause", """{"scope":"all","mode":"soft","reason":"x"}""").use { it.body.string() }
        val id = Regex("\"id\":\"([^\"]+)\"").find(body)!!.groupValues[1]
        delete("/v1/pause/rules/$id").use { r -> assertEquals(204, r.code) }
        assertTrue(daemon.state.rules.isEmpty())
        delete("/v1/pause/rules/$id").use { r -> assertEquals(404, r.code) }
    }

    @Test
    fun `the first SSE event is a snapshot and emitted events follow`() {
        val request = Request.Builder()
            .url(url("/v1/events"))
            .header("Authorization", "Bearer ${daemon.token}")
            .header("Accept", "text/event-stream")
            .get()
            .build()
        client.newCall(request).execute().use { response ->
            assertEquals(200, response.code)
            assertTrue(response.header("Content-Type")!!.startsWith("text/event-stream"))
            val source = response.body.source()

            val firstEvent = generateSequence { source.readUtf8Line() }.first { it.startsWith("event:") }
            assertEquals("event: snapshot", firstEvent)
            val data = generateSequence { source.readUtf8Line() }.first { it.startsWith("data:") }
            assertTrue(data.contains("\"summary\""))
            assertTrue(data.contains("\"sessions\""))

            daemon.emit("heartbeat", "{}")
            val next = generateSequence { source.readUtf8Line() }.first { it.startsWith("event:") }
            assertEquals("event: heartbeat", next)
        }
    }

    @Test
    fun `warnCrossing walks weekly_all past both thresholds`() {
        val d = FakeDaemon(port = ServerSocket(0).use { it.localPort }, scenario = Scenarios.warnCrossing)
        d.start()
        try {
            assertEquals(70, d.state.limit("weekly_all")!!.percent)
            assertEquals("ok", d.state.status.byId["weekly_all"])
            repeat(4) { d.tick() }
            assertEquals(82, d.state.limit("weekly_all")!!.percent)
            assertEquals("warn", d.state.status.byId["weekly_all"])
            repeat(5) { d.tick() }
            assertEquals(97, d.state.limit("weekly_all")!!.percent)
            assertEquals("critical", d.state.status.byId["weekly_all"])
            repeat(5) { d.tick() }
            assertEquals("it stops at 97", 97, d.state.limit("weekly_all")!!.percent)
        } finally {
            d.stop()
        }
    }

    @Test
    fun `freeze hard-freezes the first session at step three`() {
        val d = FakeDaemon(port = ServerSocket(0).use { it.localPort }, scenario = Scenarios.freeze)
        d.start()
        try {
            repeat(2) { d.tick() }
            assertTrue(d.state.sessions.first().pause == null)
            d.tick()
            val pause = d.state.sessions.first().pause!!
            assertEquals("hard", pause.mode)
            assertTrue(pause.frozenPids.isEmpty())
            assertEquals(1, pause.freezes)
            assertEquals(1, d.state.rules.size)
        } finally {
            d.stop()
        }
    }

    @Test
    fun `machineDrop stops and later resumes heartbeats`() {
        val d = FakeDaemon(port = ServerSocket(0).use { it.localPort }, scenario = Scenarios.machineDrop)
        d.start()
        try {
            assertTrue(d.state.heartbeats)
            repeat(6) { d.tick() }
            assertTrue("heartbeats stop after step 5", !d.state.heartbeats)
            repeat(90) { d.tick() }
            assertTrue("heartbeats come back after three minutes", d.state.heartbeats)
        } finally {
            d.stop()
        }
    }

    @Test
    fun `tokenRotated starts rejecting the old token, even on loopback`() {
        val p = ServerSocket(0).use { it.localPort }
        val d = FakeDaemon(port = p, scenario = Scenarios.tokenRotated)
        d.start()
        try {
            val summary = {
                Request.Builder().url(
                    "http://127.0.0.1:$p/v1/summary"
                ).header("Authorization", "Bearer ${d.token}").build()
            }
            client.newCall(summary()).execute().use { assertEquals(200, it.code) }
            repeat(5) { d.tick() }
            client.newCall(summary()).execute().use { r ->
                assertEquals(401, r.code)
                assertTrue(r.body.string().contains("unauthorized"))
            }
        } finally {
            d.stop()
        }
    }

    @Test
    fun `every read needs the bearer, from loopback too`() {
        listOf("/v1/summary", "/v1/sessions", "/v1/limits", "/v1/pause/rules", "/v1/events").forEach { path ->
            get(path, token = null).use { r -> assertEquals(path, 401, r.code) }
            get(path, token = "nope").use { r -> assertEquals(path, 401, r.code) }
        }
    }

    @Test
    fun `health without the bearer is liveness only`() {
        get("/health", token = null).use { r ->
            assertEquals(200, r.code)
            assertEquals("""{"ok":true}""", r.body.string())
        }
        get("/health").use { r -> assertTrue(r.body.string().contains("\"name\"")) }
    }

    @Test
    fun `no two daemons share a token and none is the old well-known one`() {
        val other = FakeDaemon(port = 0)
        assertTrue(daemon.token != other.token)
        assertTrue(daemon.token.length >= 43)
        assertTrue(daemon.token != "fake-token")
    }

    @Test
    fun `https listens on loopback unless told otherwise`() {
        assertEquals("127.0.0.1", daemon.bind)
        assertEquals("127.0.0.1", Args.parse(emptyArray()).bind)
        assertEquals("0.0.0.0", Args.parse(arrayOf("--bind", "0.0.0.0")).bind)
    }

    private fun invite(d: FakeDaemon = daemon) = PairingInvite.parse(d.pairingLink()).getOrThrow()

    @Test
    fun `a pairing link is redeemed once over pinned https for the token`() = runBlocking {
        val link = invite()
        assertEquals(daemon.fingerprint, link.fp)
        assertEquals(daemon.tlsPort, link.port)

        val config = PairingClient(OkHttpClient()).redeem(link)
        assertEquals(daemon.token, config.token)
        assertEquals(daemon.fingerprint, config.fp)

        val again = runCatching { PairingClient(OkHttpClient()).redeem(link) }.exceptionOrNull()
        assertEquals("unauthorized", (again as DaemonException).code)
    }

    @Test
    fun `the paired config reads and streams over pinned https`() = runBlocking {
        val config = PairingClient(OkHttpClient()).redeem(invite())
        val api = OkHttpDaemonApi(config, OkHttpClient())
        assertEquals("fake-mbp", api.health().name)
        assertTrue(api.sessions(null) is SessionsResult.Changed)

        val first = DaemonEventSource(config, OkHttpClient()).events().first { it is DaemonEvent.Snapshot }
        assertEquals("fake-mbp", (first as DaemonEvent.Snapshot).name)
    }

    @Test
    fun `a wrong fingerprint is refused before the code is sent`() = runBlocking {
        val link = invite()
        val forged = PairingInvite(link.name, link.addrs, link.port, "0".repeat(64), link.code)
        val e = runCatching { PairingClient(OkHttpClient()).redeem(forged) }.exceptionOrNull()
        assertEquals("pinning", (e as DaemonException).code)
        // The code never left: the genuine link still works.
        assertEquals(daemon.token, PairingClient(OkHttpClient()).redeem(link).token)
    }

    @Test
    fun `pairing is not served on the plain http port`() {
        val code = invite().code
        post("/v1/pair", """{"code":"$code"}""", token = null).use { r -> assertEquals(404, r.code) }
    }

    @Test
    fun `repeated wrong codes are rate limited`() = runBlocking {
        val link = invite()
        val wrong = PairingInvite(link.name, link.addrs, link.port, link.fp, "x".repeat(32))
        val codes = (1..6).map {
            (runCatching { PairingClient(OkHttpClient()).redeem(wrong) }.exceptionOrNull() as DaemonException).code
        }
        assertEquals(List(5) { "unauthorized" } + "rate_limited", codes)
    }

    @Test
    fun `the demo persona shows a made-up person and no real home directory`() {
        val state = FakeState(name = "fake-mbp").also { it.applyDemoPersona() }

        assertEquals(FakeState.DEMO_USER, state.user)
        val paths = state.sessions.flatMap {
            listOfNotNull(it.cwd, it.transcriptPath, it.worktree, it.project.gitCommonDir)
        } +
            state.projectGroups.flatMap { listOf(it.key, it.label) }
        assertTrue(paths.isNotEmpty())
        paths.filter { it.contains("Users") }.forEach { path ->
            assertTrue(path, path.startsWith("/Users/you/") || path.contains("-Users-you-"))
        }
        assertTrue(Args.parse(arrayOf("--demo")).demo)
        assertTrue(!Args.parse(emptyArray()).demo)
    }

    @Test
    fun `noFiveHour serves weeks only`() {
        val s = FakeState(name = "studio")
        Scenarios.noFiveHour.init(s)
        assertEquals(null, s.limit("session"))
        assertTrue(s.limit("weekly_all") != null)
    }

    @Test
    fun `scenarios resolve by name and default to idle`() {
        assertEquals("idle", Scenarios.byName("idle").name)
        assertEquals("warnCrossing", Scenarios.byName("warnCrossing").name)
        assertEquals("freeze", Scenarios.byName("freeze").name)
        assertEquals("machineDrop", Scenarios.byName("machineDrop").name)
        assertEquals("tokenRotated", Scenarios.byName("tokenRotated").name)
        assertEquals("noFiveHour", Scenarios.byName("noFiveHour").name)
        assertEquals("idle", Scenarios.byName("nonsense").name)
    }

    @Test
    fun `args parse port scenario and token with a 47299 default port`() {
        val defaults = Args.parse(emptyArray())
        assertEquals(47299, defaults.port)
        assertEquals("idle", defaults.scenario.name)

        val parsed = Args.parse(arrayOf("--port", "1234", "--scenario", "freeze", "--token", "zzz"))
        assertEquals(1234, parsed.port)
        assertEquals("freeze", parsed.scenario.name)
        assertEquals("zzz", parsed.token)
        assertEquals(null, defaults.token)
        assertEquals(listOf("10.0.2.2", "127.0.0.1"), defaults.addrs)
        assertEquals(4321, Args.parse(arrayOf("--tls-port", "4321")).tlsPort)
        assertEquals("/tmp/l", Args.parse(arrayOf("--link-file", "/tmp/l")).linkFile)
    }
}
