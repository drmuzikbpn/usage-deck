// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.wifi

import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class CaptivePortalTest {
    private val view = WebView(ApplicationProvider.getApplicationContext())

    private fun request(url: String, mainFrame: Boolean = true) = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)

        override fun isForMainFrame() = mainFrame

        override fun isRedirect() = false

        override fun hasGesture() = true

        override fun getMethod() = "GET"

        override fun getRequestHeaders() = emptyMap<String, String>()
    }

    @Test
    fun `only http and https may be navigated to`() {
        listOf("http://portal.example.test/login", "https://portal.example.test/", "HTTPS://portal.example.test/")
            .forEach { assertTrue(it, PortalPolicy.allows(it)) }
        listOf(
            "file:///data/data/com.evenseal.usagedeck/shared_prefs/machines.xml",
            "content://com.android.providers.media/x",
            "intent://scan/#Intent;scheme=zxing;end",
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "market://details?id=x",
            "tel:123",
            "about:blank",
            "",
            "not a url"
        ).forEach { assertFalse(it, PortalPolicy.allows(it)) }
        assertFalse(PortalPolicy.allows(null))
    }

    @Test
    fun `the client refuses every other scheme and lets http through`() {
        val client = PortalClient()
        assertTrue(client.shouldOverrideUrlLoading(view, request("file:///sdcard/x")))
        assertTrue(client.shouldOverrideUrlLoading(view, request("intent://x#Intent;end")))
        assertFalse(client.shouldOverrideUrlLoading(view, request("http://portal.example.test/")))
        @Suppress("DEPRECATION")
        assertTrue(client.shouldOverrideUrlLoading(view, "content://x/y"))
    }

    @Test
    fun `a file or content subresource is answered with nothing`() {
        val client = PortalClient()
        assertEquals(
            403,
            client.shouldInterceptRequest(view, request("file:///etc/hosts", mainFrame = false))?.statusCode
        )
        assertEquals(403, client.shouldInterceptRequest(view, request("content://x/y", mainFrame = false))?.statusCode)
        assertNull(client.shouldInterceptRequest(view, request("https://portal.example.test/a.css", mainFrame = false)))
    }

    @Test
    fun `the web view cannot read files or content, mix content or open windows`() {
        PortalPolicy.harden(view)

        val s = view.settings
        assertFalse(s.allowFileAccess)
        assertFalse(s.allowContentAccess)
        @Suppress("DEPRECATION")
        assertFalse(s.allowFileAccessFromFileURLs)
        @Suppress("DEPRECATION")
        assertFalse(s.allowUniversalAccessFromFileURLs)
        assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, s.mixedContentMode)
        assertFalse(s.javaScriptCanOpenWindowsAutomatically)
        assertFalse(s.supportMultipleWindows())
        @Suppress("DEPRECATION")
        assertFalse(s.saveFormData)
        // A portal's login page does need script and DOM storage; both are wiped on the way out.
        assertTrue(s.javaScriptEnabled)
        assertTrue(s.domStorageEnabled)
    }

    @Test
    fun `leaving the portal wipes cookies, cache and history and destroys the view`() {
        CookieManager.getInstance().setCookie("http://portal.example.test", "session=abc")

        PortalPolicy.wipe(view)

        assertNull(CookieManager.getInstance().getCookie("http://portal.example.test"))
        val shadow = shadowOf(view)
        assertTrue(shadow.wasClearCacheCalled())
        assertTrue(shadow.wasClearHistoryCalled())
        assertTrue(shadow.wasDestroyCalled())
    }

    @Test
    fun `finishing the activity wipes what the portal left behind`() {
        val controller = Robolectric.buildActivity(CaptivePortalActivity::class.java).setup()
        CookieManager.getInstance().setCookie("http://portal.example.test", "session=abc")

        controller.get().finish()
        controller.pause().stop().destroy()

        assertNull(CookieManager.getInstance().getCookie("http://portal.example.test"))
    }

    @Test
    fun `no javascript interface is ever exposed`() {
        val offenders = File("src/main/kotlin").walkTopDown()
            .filter { it.extension == "kt" && "addJavascriptInterface" in it.readText() }
            .map { it.name }.toList()
        assertEquals(emptyList<String>(), offenders)
    }
}
