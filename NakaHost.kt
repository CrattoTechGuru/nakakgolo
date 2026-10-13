package com.nakakgolo.overlay

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.ContextThemeWrapper
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

/**
 * Owns the single WebView that runs NakaKgolo. The same WebView moves between the full-screen
 * activity and the floating window, so login and the current session are never lost.
 */
object NakaHost {
    private const val START_URL = "https://appassets.androidplatform.net/assets/index.html"

    /** True while the floating window is showing. */
    @Volatile var overlayActive = false

    /** The full-screen activity, only while it is resumed (visible). */
    @Volatile var activity: Activity? = null

    private var web: WebView? = null

    fun webView(app: Context): WebView {
        web?.let { return it }
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(app))
            .build()
        val view = WebView(app).apply {
            setBackgroundColor(0xFF080D1A.toInt())
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            addJavascriptInterface(FloatBridge(app), "NakaKgoloAndroid")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? =
                    request?.url?.let { loader.shouldInterceptRequest(it) }
            }
            // The app uses confirm() for its reset buttons. Show them as real dialogs.
            webChromeClient = object : WebChromeClient() {
                override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                    showDialog(app, message, result, withCancel = true)
                    return true
                }
                override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                    showDialog(app, message, result, withCancel = false)
                    return true
                }
            }
            loadUrl(START_URL)
        }
        web = view
        return view
    }

    private fun showDialog(app: Context, message: String?, result: JsResult?, withCancel: Boolean) {
        val current = activity
        // Use the full-screen activity when it is visible; otherwise show over other apps.
        val ctx: Context = current ?: ContextThemeWrapper(app, android.R.style.Theme_DeviceDefault_Dialog)
        val builder = AlertDialog.Builder(ctx)
            .setMessage(message)
            .setPositiveButton("OK") { _, _ -> result?.confirm() }
        if (withCancel) builder.setNegativeButton("Cancel") { _, _ -> result?.cancel() }
        val dialog = builder.setOnCancelListener { result?.cancel() }.create()
        if (current == null) dialog.window?.setType(WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY)
        dialog.show()
    }

    /** Removes the WebView from whichever window currently holds it and returns it. */
    fun takeWebView(app: Context): WebView {
        val view = webView(app)
        (view.parent as? ViewGroup)?.removeView(view)
        return view
    }
}

/** Called from the web app's Settings > Enable Floating Window button (Android only). */
class FloatBridge(private val app: Context) {
    private val main = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun startFloating() {
        main.post {
            if (!Settings.canDrawOverlays(app)) {
                app.startActivity(
                    Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${app.packageName}"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                )
                return@post
            }
            app.startForegroundService(
                Intent(app, OverlayService::class.java).setAction(OverlayService.ACTION_START)
            )
            // Send the full-screen app to the background; the floating window takes over.
            NakaHost.activity?.moveTaskToBack(true)
        }
    }
}
