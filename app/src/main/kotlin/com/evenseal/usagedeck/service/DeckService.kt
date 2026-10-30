// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Even Seal Productions

package com.evenseal.usagedeck.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.util.Log
import androidx.lifecycle.LifecycleService
import com.evenseal.usagedeck.BuildConfig
import com.evenseal.usagedeck.MainActivity
import com.evenseal.usagedeck.UsageDeckApp

/**
 * Keeps the [DeckEngine] running with the app out of sight. On the kiosk that is always: the stream
 * survives the screen going off in battery mode (spec §5). On a phone it is the user's choice, the
 * "Keep watching in the background" switch, and the ongoing notification says it is running.
 */
class DeckService : LifecycleService() {
    private val graph: DeckGraph by lazy { (application as UsageDeckApp).graph }

    /** False when the encrypted store is unavailable: the service then owns nothing and stops. */
    private var running = false

    override fun onCreate() {
        super.onCreate()
        if ((application as UsageDeckApp).storageFailure != null) {
            stopSelf()
            return
        }
        if (!enterForeground()) {
            stopSelf()
            return
        }
        running = true
        graph.engine.acquire(DeckEngine.Hold.SERVICE)
    }

    /** Android refuses a phone app's restart from the background; it is re-armed on the next open. */
    private fun enterForeground(): Boolean = try {
        if (BuildConfig.KIOSK) {
            startForeground(NOTIFICATION_ID, buildNotification())
        } else {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        }
        true
    } catch (e: IllegalStateException) {
        Log.w(TAG, "could not enter the foreground", e)
        false
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        return if (running && BuildConfig.KIOSK) START_STICKY else START_NOT_STICKY
    }

    override fun onDestroy() {
        if (running) graph.engine.release(DeckEngine.Hold.SERVICE)
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Usage Deck", NotificationManager.IMPORTANCE_LOW)
        )
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(if (BuildConfig.KIOSK) "Usage Deck running" else "Watching your Claude limits")
            .setContentIntent(open)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val NOTIFICATION_ID = 1
        private const val CHANNEL_ID = "usage_deck_service"
        private const val TAG = "UsageDeckService"

        fun start(context: Context) {
            val intent = Intent(context, DeckService::class.java)
            if (BuildConfig.KIOSK) {
                context.startService(intent)
                return
            }
            try {
                context.startForegroundService(intent)
            } catch (e: IllegalStateException) {
                // ForegroundServiceStartNotAllowedException: retried when the app is next opened.
                Log.w(TAG, "background watching not started", e)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, DeckService::class.java))
        }
    }
}
