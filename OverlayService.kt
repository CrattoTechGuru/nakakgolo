package com.nakakgolo.overlay

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.max

/** Shows the shared NakaKgolo WebView in a small window above other apps. */
class OverlayService : Service() {

    companion object {
        const val ACTION_START = "com.nakakgolo.overlay.START"
        const val ACTION_STOP = "com.nakakgolo.overlay.STOP"
        const val ACTION_RETURN = "com.nakakgolo.overlay.RETURN"
        private const val CHANNEL_ID = "nakakgolo_overlay"
        private const val NOTIFICATION_ID = 1
    }

    private var windowManager: WindowManager? = null
    private var overlayRoot: LinearLayout? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> stopSelf()
            ACTION_RETURN -> returnToApp()
            else -> {
                startInForeground()
                if (overlayRoot == null) showOverlay()
            }
        }
        return START_NOT_STICKY
    }

    /** Opens the full-screen app and closes the floating window. */
    private fun returnToApp() {
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        stopSelf()
    }

    private fun startInForeground() {
        val channel = NotificationChannel(CHANNEL_ID, "Floating window", NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)

        val openIntent = PendingIntent.getService(
            this, 0,
            Intent(this, OverlayService::class.java).setAction(ACTION_RETURN),
            PendingIntent.FLAG_IMMUTABLE
        )
        val notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("NakaKgolo is floating")
            .setContentText("Tap Open app to return to the full screen app.")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .addAction(
                Notification.Action.Builder(
                    Icon.createWithResource(this, android.R.drawable.ic_menu_revert),
                    "Open app",
                    openIntent
                ).build()
            )
            .build()

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun showOverlay() {
        if (!Settings.canDrawOverlays(this)) {
            stopSelf()
            return
        }
        val density = resources.displayMetrics.density
        fun dp(v: Float): Int = (v * density).toInt()

        // Thin title bar: drag to move, ✕ returns to the full-screen app.
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(0xFF0F1729.toInt())
            setPadding(dp(10f), 0, dp(4f), 0)
        }
        val titleView = TextView(this).apply {
            text = "🎯 NakaKgolo  · drag to move"
            textSize = 13f
            setTextColor(0xFFF59E0B.toInt())
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(0, dp(36f), 1f)
        }
        val closeView = TextView(this).apply {
            text = "⤢"
            textSize = 18f
            setTextColor(0xFFE2E8F0.toInt())
            gravity = Gravity.CENTER
            setPadding(dp(12f), 0, dp(12f), 0)
            layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, dp(36f))
            setOnClickListener { returnToApp() }
        }
        header.addView(titleView)
        header.addView(closeView)

        // Bottom-right corner grip: drag to resize.
        val grip = TextView(this).apply {
            text = "◢"
            textSize = 14f
            setTextColor(0xFF3B82F6.toInt())
            gravity = Gravity.CENTER
            layoutParams = LinearLayout.LayoutParams(dp(24f), dp(20f))
        }
        val footer = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            setBackgroundColor(0xFF0F1729.toInt())
            addView(grip)
        }

        // The shared full app WebView goes into the middle of the window.
        val web = NakaHost.takeWebView(applicationContext)

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(header, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(web, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(footer, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        }

        // TYPE_APPLICATION_OVERLAY draws above other apps. NOT_TOUCH_MODAL lets touches
        // outside this small window reach the apps underneath.
        val layoutParams = WindowManager.LayoutParams(
            dp(340f), dp(540f),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = dp(16f)
            y = dp(120f)
        }

        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        wm.addView(column, layoutParams)
        windowManager = wm
        overlayRoot = column
        NakaHost.overlayActive = true
        web.onResume()

        val screenW = resources.displayMetrics.widthPixels
        val screenH = resources.displayMetrics.heightPixels

        var dragRawX = 0f
        var dragRawY = 0f
        var dragStartX = 0
        var dragStartY = 0
        header.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    dragRawX = e.rawX
                    dragRawY = e.rawY
                    dragStartX = layoutParams.x
                    dragStartY = layoutParams.y
                }
                MotionEvent.ACTION_MOVE -> {
                    layoutParams.x = (dragStartX + (e.rawX - dragRawX).toInt())
                        .coerceIn(0, max(0, screenW - layoutParams.width))
                    layoutParams.y = (dragStartY + (e.rawY - dragRawY).toInt())
                        .coerceIn(0, max(0, screenH - layoutParams.height))
                    wm.updateViewLayout(column, layoutParams)
                }
            }
            true
        }

        var resizeRawX = 0f
        var resizeRawY = 0f
        var resizeStartW = 0
        var resizeStartH = 0
        grip.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    resizeRawX = e.rawX
                    resizeRawY = e.rawY
                    resizeStartW = layoutParams.width
                    resizeStartH = layoutParams.height
                }
                MotionEvent.ACTION_MOVE -> {
                    layoutParams.width = max(dp(260f), resizeStartW + (e.rawX - resizeRawX).toInt())
                        .coerceAtMost(max(dp(260f), screenW - layoutParams.x))
                    layoutParams.height = max(dp(320f), resizeStartH + (e.rawY - resizeRawY).toInt())
                        .coerceAtMost(max(dp(320f), screenH - layoutParams.y))
                    wm.updateViewLayout(column, layoutParams)
                }
            }
            true
        }
    }

    override fun onDestroy() {
        NakaHost.overlayActive = false
        overlayRoot?.let { root -> runCatching { windowManager?.removeView(root) } }
        overlayRoot = null
        windowManager = null
        super.onDestroy()
    }
}
