package com.iftaarcountdown.widget

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.content.edit
import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

object PrayerTimesCache {
  const val ACTION_SYNC_CACHE = "com.iftaarcountdown.widget.ACTION_SYNC_CACHE"

  private const val PREFS_NAME = "prayer_times_cache"
  private const val KEY_CACHE_JSON = "cache_json"
  private const val KEY_RETRY_UNTIL_MS = "retry_until_ms"

  private val isoDate: DateTimeFormatter = DateTimeFormatter.ISO_LOCAL_DATE
  private val timeFormat: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

  data class CachedDay(
    val times: PrayerTimes,
    val hijriLabel: String,
    val gregorianLabel: String
  )

  fun getToday(context: Context): PrayerTimes? {
    return getForDate(context, LocalDate.now())
  }

  fun getForDate(context: Context, date: LocalDate): PrayerTimes? {
    return getDayForDate(context, date)?.times
  }

  fun getDayForDate(context: Context, date: LocalDate): CachedDay? {
    val raw = prefs(context).getString(KEY_CACHE_JSON, null) ?: return null
    val root = JSONObject(raw)
    val item = root.optJSONObject(date.format(isoDate)) ?: return null

    return CachedDay(
      times = PrayerTimes(
        fajr = LocalTime.parse(item.optString("fajr", "00:00"), timeFormat),
        dhuhr = LocalTime.parse(item.optString("dhuhr", "00:00"), timeFormat),
        asr = LocalTime.parse(item.optString("asr", "00:00"), timeFormat),
        maghrib = LocalTime.parse(item.optString("maghrib", "00:00"), timeFormat),
        isha = LocalTime.parse(item.optString("isha", "00:00"), timeFormat)
      ),
      hijriLabel = item.optString("hijri", ""),
      gregorianLabel = item.optString("gregorian", "")
    )
  }

  fun syncNow(context: Context): Boolean {
    val settings = WidgetSettings.load(context)
    if (!hasLocationOrManualCity(settings)) {
      return false
    }

    val today = LocalDate.now()
    val dates = listOf(today, today.plusDays(1), today.plusDays(2))
    val root = JSONObject()

    dates.forEach { date ->
      val day = PrayerApiClient.getPrayerDayForDate(settings, date) ?: return false
      root.put(date.format(isoDate), JSONObject().apply {
        put("fajr", day.times.fajr.format(timeFormat))
        put("dhuhr", day.times.dhuhr.format(timeFormat))
        put("asr", day.times.asr.format(timeFormat))
        put("maghrib", day.times.maghrib.format(timeFormat))
        put("isha", day.times.isha.format(timeFormat))
        put("hijri", day.hijriLabel)
        put("gregorian", day.gregorianLabel)
      })
    }

    prefs(context).edit {
      putString(KEY_CACHE_JSON, root.toString())
      remove(KEY_RETRY_UNTIL_MS)
    }

    scheduleNextMidnightSync(context)
    return true
  }

  fun ensureCurrentData(context: Context): PrayerTimes? {
    val cached = getToday(context)
    if (cached != null) {
      return cached
    }

    val synced = syncNow(context)
    if (!synced) {
      val retryUntil = prefs(context).getLong(KEY_RETRY_UNTIL_MS, 0L)
      if (retryUntil <= 0L) {
        val threeDaysLater = System.currentTimeMillis() + 3L * 24L * 60L * 60L * 1000L
        prefs(context).edit { putLong(KEY_RETRY_UNTIL_MS, threeDaysLater) }
      }
      scheduleRetry(context)
      return null
    }

    return getToday(context)
  }

  fun onSyncAlarm(context: Context) {
    val success = syncNow(context)
    if (success) {
      PrayerWidgetUpdater.startRefresh(context)
      return
    }

    val retryUntil = prefs(context).getLong(KEY_RETRY_UNTIL_MS, 0L)
    if (retryUntil <= 0L) {
      val threeDaysLater = System.currentTimeMillis() + 3L * 24L * 60L * 60L * 1000L
      prefs(context).edit { putLong(KEY_RETRY_UNTIL_MS, threeDaysLater) }
      scheduleRetry(context)
      return
    }

    if (System.currentTimeMillis() < retryUntil) {
      scheduleRetry(context)
    } else {
      prefs(context).edit { remove(KEY_RETRY_UNTIL_MS) }
      scheduleNextMidnightSync(context)
    }
  }

  fun scheduleNextMidnightSync(context: Context) {
    val now = LocalDateTime.now()
    val nextMidnight = now.toLocalDate().plusDays(1).atStartOfDay().atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
    scheduleAt(context, nextMidnight)
  }

  fun scheduleRetry(context: Context) {
    val trigger = System.currentTimeMillis() + 10L * 60L * 1000L
    scheduleAt(context, trigger)
  }

  private fun scheduleAt(context: Context, triggerMillis: Long) {
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val pendingIntent = syncPendingIntent(context)

    alarmManager.cancel(pendingIntent)

    try {
      alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMillis, pendingIntent)
    } catch (_: SecurityException) {
      alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerMillis, pendingIntent)
    }
  }

  private fun syncPendingIntent(context: Context): PendingIntent {
    val intent = Intent(context, PrayerUpdateReceiver::class.java).apply {
      action = ACTION_SYNC_CACHE
    }
    return PendingIntent.getBroadcast(
      context,
      3002,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun hasLocationOrManualCity(settings: UserSettings): Boolean {
    val hasCoordinates = settings.latitude != null && settings.longitude != null
    val hasCity = settings.city.isNotBlank() && settings.country.isNotBlank()
    return hasCoordinates || hasCity
  }

  private fun prefs(context: Context) =
    context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
}
