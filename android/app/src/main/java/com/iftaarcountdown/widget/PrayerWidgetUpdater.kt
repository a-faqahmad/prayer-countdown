package com.iftaarcountdown.widget

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat
import com.iftaarcountdown.R
import java.time.Duration
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.Executors

data class WidgetState(
  val currentPrayer: String,
  val nextPrayer: String,
  val countdown: String,
  val now: LocalDateTime,
  val nextPrayerAtMillis: Long,
  val prayerStartMoments: List<Pair<String, LocalDateTime>>
)

object PrayerWidgetUpdater {
  const val ACTION_WIDGET_TICK = "com.iftaarcountdown.widget.ACTION_WIDGET_TICK"
  private const val CHANNEL_ID = "prayer_notifications"
  private const val NOTIFICATION_ID = 1100
  private const val PREFS_NAME = "widget_runtime_state"
  private const val KEY_LAST_CURRENT = "last_current"
  private const val KEY_LAST_NEXT = "last_next"
  private const val KEY_LAST_NEXT_AT = "last_next_at"
  private val backgroundExecutor = Executors.newSingleThreadExecutor()

  fun startRefresh(context: Context) {
    backgroundExecutor.execute {
      refreshInternal(context.applicationContext)
    }
  }

  fun refreshInternal(context: Context) {
    val settings = WidgetSettings.load(context)
    if (!hasLocationOrManualCity(settings)) {
      renderAll(context, "location required", "next prayer: --", null, "--, --")
      scheduleRetry(context, minutes = 5)
      return
    }

    val prayerTimes = PrayerTimesCache.ensureCurrentData(context)
    if (prayerTimes == null) {
      val fallback = loadLastState(context)
      if (fallback != null) {
        val (lastCurrent, lastNext, lastNextAt) = fallback
        if (System.currentTimeMillis() >= lastNextAt) {
          // Countdown reached zero and no new data yet: keep it pinned at zero.
          renderAll(context, lastCurrent, lastNext, null, "--, --", "00:00:00")
        } else {
          // Keep prior countdown running until boundary.
          renderAll(context, lastCurrent, lastNext, lastNextAt, "--, --")
        }
      } else {
        renderAll(context, "unable to load", "next prayer: --", null, "--, --")
      }
      scheduleRetry(context, minutes = 5)
      return
    }

    val state = buildWidgetState(prayerTimes)
    val dateText = buildDateText(context, prayerTimes)
    val nextLabel = "next prayer: ${state.nextPrayer}"
    saveLastState(context, state.currentPrayer, nextLabel, state.nextPrayerAtMillis)
    renderAll(
      context = context,
      current = state.currentPrayer,
      next = nextLabel,
      nextPrayerAtMillis = state.nextPrayerAtMillis,
      dateText = dateText
    )

    maybeShowPrayerNotification(context, settings, state)
    scheduleNextPrayerUpdate(context, state.nextPrayerAtMillis)
  }

  private fun hasLocationOrManualCity(settings: UserSettings): Boolean {
    val hasCoordinates = settings.latitude != null && settings.longitude != null
    val hasCity = settings.city.isNotBlank() && settings.country.isNotBlank()
    return hasCoordinates || hasCity
  }

  private fun buildWidgetState(prayerTimes: PrayerTimes): WidgetState {
    val now = LocalDateTime.now()
    val effectiveNow = now.plusSeconds(1)
    val today = LocalDate.now()

    val fajr = LocalDateTime.of(today, prayerTimes.fajr)
    val dhuhr = LocalDateTime.of(today, prayerTimes.dhuhr)
    val asr = LocalDateTime.of(today, prayerTimes.asr)
    val maghrib = LocalDateTime.of(today, prayerTimes.maghrib)
    val isha = LocalDateTime.of(today, prayerTimes.isha)
    val nextDayFajr = LocalDateTime.of(today.plusDays(1), prayerTimes.fajr)

    val prayerStartMoments = listOf(
      "Fajr" to fajr,
      "Dhuhr" to dhuhr,
      "Asr" to asr,
      "Maghrib" to maghrib,
      "Isha" to isha
    )

    val (currentPrayer, nextPrayer, nextMoment) = when {
      effectiveNow.isBefore(fajr) -> Triple("Isha", "Fajr", fajr)
      effectiveNow.isBefore(dhuhr) -> Triple("Fajr", "Dhuhr", dhuhr)
      effectiveNow.isBefore(asr) -> Triple("Dhuhr", "Asr", asr)
      effectiveNow.isBefore(maghrib) -> Triple("Asr", "Maghrib", maghrib)
      effectiveNow.isBefore(isha) -> Triple("Maghrib", "Isha", isha)
      else -> Triple("Isha", "Fajr", nextDayFajr)
    }

    val countdownDuration = Duration.between(now, nextMoment).coerceAtLeast(Duration.ZERO)
    val nextPrayerAtMillis = nextMoment
      .atZone(ZoneId.systemDefault())
      .toInstant()
      .toEpochMilli()

    return WidgetState(
      currentPrayer = currentPrayer,
      nextPrayer = nextPrayer,
      countdown = formatDuration(countdownDuration),
      now = now,
      nextPrayerAtMillis = nextPrayerAtMillis,
      prayerStartMoments = prayerStartMoments
    )
  }

  private fun formatDuration(duration: Duration): String {
    val totalSeconds = duration.seconds
    val hours = totalSeconds / 3600
    val minutes = (totalSeconds % 3600) / 60
    val seconds = totalSeconds % 60
    return String.format("%02d:%02d:%02d", hours, minutes, seconds)
  }

  private fun renderAll(
    context: Context,
    current: String,
    next: String,
    nextPrayerAtMillis: Long?,
    dateText: String,
    fixedCountdown: String? = null
  ) {
    val appWidgetManager = AppWidgetManager.getInstance(context)
    val component = ComponentName(context, PrayerWidgetProvider::class.java)
    val ids = appWidgetManager.getAppWidgetIds(component)

    if (ids.isEmpty()) {
      return
    }

    ids.forEach { id ->
      val views = RemoteViews(context.packageName, R.layout.prayer_widget)
      views.setTextViewText(R.id.textCurrentPrayer, current)
      views.setTextViewText(R.id.textNextPrayer, next)
      views.setTextViewText(R.id.textDate, dateText)
      attachOpenAppIntent(context, views)

      if (nextPrayerAtMillis == null) {
        views.setTextViewText(R.id.textCountdown, fixedCountdown ?: "--:--:--")
        views.setChronometer(R.id.textCountdown, SystemClock.elapsedRealtime(), null, false)
      } else {
        val remainingMillis = (nextPrayerAtMillis - System.currentTimeMillis()).coerceAtLeast(0L)
        if (remainingMillis <= 0L) {
          // Never allow forward/backward drift around zero.
          views.setTextViewText(R.id.textCountdown, "00:00:00")
          views.setChronometer(R.id.textCountdown, SystemClock.elapsedRealtime(), null, false)
        } else {
          val base = SystemClock.elapsedRealtime() + remainingMillis
          views.setChronometerCountDown(R.id.textCountdown, true)
          views.setChronometer(R.id.textCountdown, base, null, true)
        }
      }

      appWidgetManager.updateAppWidget(id, views)
    }
  }

  private fun buildDateText(context: Context, todayTimes: PrayerTimes): String {
    val today = LocalDate.now()
    val todayDay = PrayerTimesCache.getDayForDate(context, today)
    val tomorrowDay = PrayerTimesCache.getDayForDate(context, today.plusDays(1))
    if (todayDay == null) {
      return "--, --"
    }

    val now = LocalDateTime.now()
    val maghribToday = LocalDateTime.of(today, todayTimes.maghrib)
    val hijri = if (!now.isBefore(maghribToday)) {
      tomorrowDay?.hijriLabel ?: todayDay.hijriLabel
    } else {
      todayDay.hijriLabel
    }
    val gregorian = todayDay.gregorianLabel
    return "$hijri, $gregorian"
  }

  private fun attachOpenAppIntent(context: Context, views: RemoteViews) {
    val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    val pendingIntent = PendingIntent.getActivity(
      context,
      4001,
      launchIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    views.setOnClickPendingIntent(R.id.widgetRoot, pendingIntent)
  }

  private fun maybeShowPrayerNotification(context: Context, settings: UserSettings, state: WidgetState) {
    if (!settings.notificationsEnabled) {
      return
    }

    val prayerToNotify = state.prayerStartMoments.firstOrNull { (_, moment) ->
      val sinceStart = Duration.between(moment, state.now)
      !sinceStart.isNegative && sinceStart.toMinutes() < 2
    } ?: return

    val keyDate = state.now.toLocalDate().format(DateTimeFormatter.ISO_LOCAL_DATE)
    val notificationKey = "$keyDate-${prayerToNotify.first}"
    if (notificationKey == settings.lastNotificationKey) {
      return
    }

    createNotificationChannel(context)

    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("Prayer time")
      .setContentText("${prayerToNotify.first} has started")
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setDefaults(NotificationCompat.DEFAULT_SOUND)
      .build()

    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(NOTIFICATION_ID, notification)

    WidgetSettings.saveLastNotification(context, notificationKey)
  }

  private fun createNotificationChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }

    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Prayer Alerts",
      NotificationManager.IMPORTANCE_HIGH
    )
    manager.createNotificationChannel(channel)
  }

  private fun scheduleRetry(context: Context, minutes: Long) {
    val triggerMillis = System.currentTimeMillis() + minutes * 60_000L
    scheduleAt(context, triggerMillis)
  }

  private fun scheduleNextPrayerUpdate(context: Context, nextPrayerAtMillis: Long) {
    val triggerMillis = nextPrayerAtMillis - 300L
    scheduleAt(context, triggerMillis)
  }

  private fun scheduleAt(context: Context, triggerMillis: Long) {
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val intent = Intent(context, PrayerUpdateReceiver::class.java).apply {
      action = ACTION_WIDGET_TICK
    }
    val pendingIntent = PendingIntent.getBroadcast(
      context,
      3001,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    alarmManager.cancel(pendingIntent)

    val safeTrigger = triggerMillis.coerceAtLeast(System.currentTimeMillis() + 1000L)

    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        alarmManager.setExactAndAllowWhileIdle(
          AlarmManager.RTC_WAKEUP,
          safeTrigger,
          pendingIntent
        )
      } else {
        alarmManager.setExact(
          AlarmManager.RTC_WAKEUP,
          safeTrigger,
          pendingIntent
        )
      }
    } catch (_: SecurityException) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        alarmManager.setAndAllowWhileIdle(
          AlarmManager.RTC_WAKEUP,
          safeTrigger,
          pendingIntent
        )
      } else {
        alarmManager.set(
          AlarmManager.RTC_WAKEUP,
          safeTrigger,
          pendingIntent
        )
      }
    }
  }

  fun cancelSchedule(context: Context) {
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val intent = Intent(context, PrayerUpdateReceiver::class.java).apply {
      action = ACTION_WIDGET_TICK
    }
    val pendingIntent = PendingIntent.getBroadcast(
      context,
      3001,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    alarmManager.cancel(pendingIntent)
  }

  private fun saveLastState(context: Context, current: String, next: String, nextAtMillis: Long) {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    prefs.edit()
      .putString(KEY_LAST_CURRENT, current)
      .putString(KEY_LAST_NEXT, next)
      .putLong(KEY_LAST_NEXT_AT, nextAtMillis)
      .apply()
  }

  private fun loadLastState(context: Context): Triple<String, String, Long>? {
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val current = prefs.getString(KEY_LAST_CURRENT, null) ?: return null
    val next = prefs.getString(KEY_LAST_NEXT, null) ?: return null
    val nextAt = prefs.getLong(KEY_LAST_NEXT_AT, 0L)
    if (nextAt <= 0L) {
      return null
    }
    return Triple(current, next, nextAt)
  }
}
