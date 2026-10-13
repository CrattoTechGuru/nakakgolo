package com.nakakgolo.overlay

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.widget.FrameLayout

/** Full-screen NakaKgolo. Shows the same WebView that the floating window uses when floating. */
class MainActivity : Activity() {

    private lateinit var container: FrameLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        container = FrameLayout(this).apply { setBackgroundColor(0xFF080D1A.toInt()) }
        setContentView(container)
        NakaHost.webView(applicationContext)  // create the app once
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun onResume() {
        super.onResume()
        NakaHost.activity = this
        if (NakaHost.overlayActive) {
            // Coming back to the full app closes the floating window.
            startService(android.content.Intent(this, OverlayService::class.java).setAction(OverlayService.ACTION_STOP))
        }
        val view = NakaHost.takeWebView(applicationContext)
        container.addView(
            view,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)
        )
        view.onResume()
    }

    override fun onPause() {
        if (NakaHost.activity === this) NakaHost.activity = null
        super.onPause()
    }

    // Back sends the app to the background so the session stays alive.
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        moveTaskToBack(true)
    }
}
