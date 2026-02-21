package com.iftaarcountdown.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context

class PrayerWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray
  ) {
    PrayerWidgetUpdater.startRefresh(context)
  }

  override fun onEnabled(context: Context) {
    PrayerWidgetUpdater.startRefresh(context)
  }

  override fun onDisabled(context: Context) {
    PrayerWidgetUpdater.cancelSchedule(context)
  }
}
