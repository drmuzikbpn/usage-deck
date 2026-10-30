// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.wifi

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import java.io.ByteArrayInputStream

/**
 * The minimal in-app browser used to clear a hotel/venue captive portal. It is whitelisted in
 * lock task, so the kiosk never has to be unpinned to get back online. Spec §6.1.
 *
 * It renders pages from a network nobody has vetted, inside the process that holds the daemon
 * tokens, so it is locked down by [PortalPolicy] and leaves nothing behind when it closes.
 */
class CaptivePortalActivity : ComponentActivity() {
    private var webView: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Whatever a previous visit left, if the process died before it could clean up.
        PortalPolicy.wipeStorage()
        setContent { CaptivePortalScreen(onCreated = { webView = it }, onDone = { finish() }) }
    }

    override fun onDestroy() {
        PortalPolicy.wipe(webView)
        webView = null
        super.onDestroy()
    }

    companion object {
        /** Requesting this URL is what makes a captive portal serve its login page. */
        const val PROBE_URL = "http://connectivitycheck.gstatic.com/generate_204"
    }
}

/** What the portal browser may do, and how it is cleaned up. */
internal object PortalPolicy {
    /** Web pages only: no `file:`, `content:`, `intent:`, `javascript:`, `data:` or app links. */
    fun allows(url: String?): Boolean {
        val scheme = url?.substringBefore(':', missingDelimiterValue = "")?.lowercase() ?: return false
        return (scheme == "http" || scheme == "https") && url.length > scheme.length + SCHEME_SEPARATOR.length &&
            url.startsWith(SCHEME_SEPARATOR, scheme.length)
    }

    /**
     * A portal's login page needs script and DOM storage, so both stay on. Everything that could
     * reach the app's own files, other apps' content, or a second window is off, mixed content is
     * never allowed, and no JavaScript interface is ever added to this view.
     */
    @SuppressLint("SetJavaScriptEnabled")
    fun harden(view: WebView) {
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            mediaPlaybackRequiresUserGesture = true
            @Suppress("DEPRECATION")
            saveFormData = false
            @Suppress("DEPRECATION")
            databaseEnabled = false
            safeBrowsingEnabled = true
        }
        view.webViewClient = PortalClient()
    }

    /** Cookies and DOM storage are process-wide, so they are cleared even without a view. */
    fun wipeStorage() {
        runCatching {
            CookieManager.getInstance().apply {
                removeAllCookies(null)
                flush()
            }
        }
        runCatching { WebStorage.getInstance().deleteAllData() }
    }

    /** Everything a visit leaves: cookies, storage, HTTP cache, history, form data — then the view itself. */
    fun wipe(view: WebView?) {
        wipeStorage()
        view ?: return
        runCatching {
            view.stopLoading()
            view.clearCache(true)
            view.clearHistory()
            view.clearFormData()
            view.clearSslPreferences()
            view.destroy()
        }
    }

    private const val SCHEME_SEPARATOR = "://"
}

/** Keeps navigation, and sub-resources, on the web. */
internal class PortalClient : WebViewClient() {
    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        !PortalPolicy.allows(request.url?.toString())

    @Deprecated("Called by WebView on old paths; kept so no path skips the scheme rule.")
    override fun shouldOverrideUrlLoading(view: WebView, url: String?): Boolean = !PortalPolicy.allows(url)

    /** Settings already deny `file:` and `content:`; a page asking for one anyway gets an empty 403. */
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        val scheme = request.url?.scheme?.lowercase()
        if (scheme != "file" && scheme != "content") return null
        return WebResourceResponse(
            "text/plain",
            "utf-8",
            FORBIDDEN,
            "Forbidden",
            emptyMap(),
            ByteArrayInputStream(ByteArray(0))
        )
    }

    private companion object {
        const val FORBIDDEN = 403
    }
}

@Composable
private fun CaptivePortalScreen(onCreated: (WebView) -> Unit, onDone: () -> Unit) {
    Column(modifier = Modifier.fillMaxSize().background(Color(0xFF0E1013))) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(text = "Captive portal", color = Color(0xFFE8EBEF), fontSize = 16.sp)
            TextButton(onClick = onDone) {
                Text(text = "Done", color = Color(0xFF8C9BFF), fontSize = 16.sp)
            }
        }
        AndroidView(
            modifier = Modifier.fillMaxWidth().weight(1f),
            factory = { context ->
                WebView(context).also { view ->
                    PortalPolicy.harden(view)
                    onCreated(view)
                    view.loadUrl(CaptivePortalActivity.PROBE_URL)
                }
            }
        )
    }
}
