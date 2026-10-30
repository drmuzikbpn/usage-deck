// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Play build permits no cleartext at all. On the kiosk the platform cannot permit cleartext for one WebView only, so the manifest has to allow it for
 * the whole app (see `res/xml/network_security_config.xml`). What keeps daemon traffic off plain
 * HTTP is therefore the code: every OkHttp client is TLS-only, and nothing but the captive-portal
 * probe may name an `http://` URL or reach for the platform's own HTTP stack.
 */
class NoCleartextTest {
    private val roots = listOf(File("src/main/kotlin"), File("../core/src/main/kotlin")) +
        if (BuildConfig.KIOSK) listOf(File("src/deck/kotlin")) else listOf(File("src/play/kotlin"))

    private fun sources() = roots.flatMap { root ->
        assertTrue("run from the app module: ${root.absolutePath}", root.isDirectory)
        root.walkTopDown().filter { it.extension == "kt" }.toList()
    }

    @Test
    fun `the captive portal probe is the only http url in the shipped sources`() {
        val offenders = sources().flatMap { file ->
            file.readLines().filter { "\"http://" in it }.map { "${file.name}: ${it.trim()}" }
        }
        val probe =
            "CaptivePortalActivity.kt: const val PROBE_URL = \"http://connectivitycheck.gstatic.com/generate_204\""
        assertEquals(if (BuildConfig.KIOSK) listOf(probe) else emptyList(), offenders)
    }

    @Test
    fun `nothing uses the platform http stack, which would honour the cleartext permission`() {
        val offenders = sources().filter { file ->
            val text = file.readText()
            "HttpURLConnection" in text || "openConnection(" in text || "DownloadManager" in text
        }.map { it.name }
        assertEquals(emptyList<String>(), offenders)
    }
}
