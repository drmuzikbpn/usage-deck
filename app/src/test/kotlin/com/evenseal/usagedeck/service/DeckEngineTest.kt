// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.service

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.evenseal.usagedeck.UsageDeckApp
import com.evenseal.usagedeck.core.model.MachineConfig
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class DeckEngineTest {
    private lateinit var graph: DeckGraph

    @Before
    fun setUp() {
        graph = (ApplicationProvider.getApplicationContext<Application>() as UsageDeckApp).graph
    }

    @After
    fun tearDown() {
        graph.engine.release(DeckEngine.Hold.UI)
        graph.engine.release(DeckEngine.Hold.SERVICE)
    }

    private fun runningClients() = runBlocking {
        withTimeout(5_000) { graph.clients.first { it.isNotEmpty() } }
    }

    private fun pairOne() {
        graph.machineStore.add(MachineConfig("m1", "mac", "192.0.2.1", 8787, "t", fp = "0".repeat(64)))
    }

    @Test
    fun `the engine stays up until the last hold goes`() {
        pairOne()
        graph.engine.acquire(DeckEngine.Hold.UI)
        graph.engine.acquire(DeckEngine.Hold.SERVICE)
        assertEquals(1, runningClients().size)

        graph.engine.release(DeckEngine.Hold.UI)
        assertEquals(1, graph.clients.value.size)

        graph.engine.release(DeckEngine.Hold.SERVICE)
        assertTrue(graph.clients.value.isEmpty())
    }

    @Test
    fun `leaving and coming back starts one client, and a stop stays stopped`() {
        pairOne()
        repeat(3) {
            graph.engine.acquire(DeckEngine.Hold.UI)
            runningClients()
            graph.engine.release(DeckEngine.Hold.UI)
        }
        runBlocking { delay(100) }
        assertTrue(graph.clients.value.isEmpty())

        graph.engine.acquire(DeckEngine.Hold.UI)
        assertEquals(1, runningClients().size)
    }

    @Test
    fun `releasing a hold never taken leaves the engine running`() {
        pairOne()
        graph.engine.acquire(DeckEngine.Hold.SERVICE)
        assertEquals(1, runningClients().size)

        graph.engine.release(DeckEngine.Hold.UI)
        assertEquals(1, graph.clients.value.size)
    }
}
