// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.pairing

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.res.ResourcesCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.evenseal.usagedeck.R
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.DefaultDecoderFactory

/**
 * Scans the pairing QR. Returns the raw text in the [EXTRA_PAYLOAD] extra; validation is
 * `PairingInvite.parse`'s job, so a bad QR produces a message on the pairing screen rather than
 * a silent failure here.
 */
class QrScanActivity : ComponentActivity() {
    private lateinit var scanner: DecoratedBarcodeView

    private val requestCamera =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) scanner.resume() else finish()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        scanner = DecoratedBarcodeView(this).apply {
            barcodeView.decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE))
            setStatusText("")
        }

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(GROUND)
            addView(warningView(), matchWidth())
            addView(
                scanner,
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            )
        }
        // Android 15 and up draw this activity edge to edge at the Play flavor's target.
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)

        scanner.decodeSingle(
            object : BarcodeCallback {
                override fun barcodeResult(result: BarcodeResult) {
                    setResult(RESULT_OK, Intent().putExtra(EXTRA_PAYLOAD, result.text))
                    finish()
                }
            }
        )
    }

    override fun onResume() {
        super.onResume()
        if (hasCameraPermission()) {
            scanner.resume()
        } else {
            requestCamera.launch(Manifest.permission.CAMERA)
        }
    }

    override fun onPause() {
        super.onPause()
        scanner.pause()
    }

    private fun hasCameraPermission(): Boolean = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
        PackageManager.PERMISSION_GRANTED

    private fun warningView(): TextView = TextView(this).apply {
        text = WARNING
        setTextColor(WARN)
        typeface = ResourcesCompat.getFont(context, R.font.ibm_plex_sans)
        gravity = Gravity.START
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
        val pad = (16 * resources.displayMetrics.density).toInt()
        setPadding(pad, pad, pad, pad)
    }

    private fun matchWidth() = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
    )

    companion object {
        /** Raw QR text; feed it to `PairingInvite.parse`. */
        const val EXTRA_PAYLOAD = "payload"

        /**
         * Daemon §23.47 / spec §6.3. A `claude-usage pair` QR holds a one-time code that expires
         * in five minutes and the fingerprint the deck will pin; it never holds the token.
         */
        const val WARNING =
            "Scan the QR straight off the Mac's screen, never off a photo or a shared screen. " +
                "A `claude-usage pair` code works once and expires after five minutes. If a code " +
                "may have been seen by someone else, run `claude-usage pair` again for a new one."

        private val GROUND = Color.parseColor("#0E1013")
        private val WARN = Color.parseColor("#F0B429")
    }
}
