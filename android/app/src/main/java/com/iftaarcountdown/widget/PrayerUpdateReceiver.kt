package com.iftaarcountdown.widget

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class PrayerUpdateReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    when (intent?.action) {
      PrayerTimesCache.ACTION_SYNC_CACHE -> PrayerTimesCache.onSyncAlarm(context)
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_TIMEZONE_CHANGED,
      Intent.ACTION_TIME_CHANGED,
      "android.intent.action.TIME_SET" -> {
        PrayerTimesCache.scheduleNextMidnightSync(context)
        PrayerWidgetUpdater.startRefresh(context)
      }
      else -> PrayerWidgetUpdater.startRefresh(context)
    }
  }
}
