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
import android.view.View
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
  const val ACTION_WIDGET_MIDNIGHT_REFRESH = "com.iftaarcountdown.widget.ACTION_WIDGET_MIDNIGHT_REFRESH"
  const val ACTION_WIDGET_FREEZE_ZERO = "com.iftaarcountdown.widget.ACTION_WIDGET_FREEZE_ZERO"
  const val ACTION_WIDGET_SAFETY_REFRESH = "com.iftaarcountdown.widget.ACTION_WIDGET_SAFETY_REFRESH"
  private const val CHANNEL_ID = "prayer_notifications"
  private const val NOTIFICATION_ID = 1100
  private const val PREFS_NAME = "widget_runtime_state"
  private const val KEY_LAST_CURRENT = "last_current"
  private const val KEY_LAST_NEXT = "last_next"
  private const val KEY_LAST_NEXT_AT = "last_next_at"

  // The widget switches to the next prayer this many seconds AFTER its start time,
  // never before. The countdown still reaches 00:00:00 at the exact prayer time and
  // holds there for the grace second, then advances. Biasing late (not early) means
  // iftar/Maghrib is never shown as arrived before it actually is.
  private const val BOUNDARY_GRACE_SECONDS = 1L
  private const val BOUNDARY_GRACE_MILLIS = BOUNDARY_GRACE_SECONDS * 1000L

  // The zero-clamp fires a short burst of exact alarms spanning the boundary instead of
  // a single one. The widget's countdown is a self-ticking Chronometer drawn by the
  // launcher, so we can't rewrite its text per second — we can only push a "freeze at
  // 00:00:00" update, and that push rides on an alarm the OS may delay by a few seconds.
  // By spreading targets from 5s before to ~1s after the boundary, at least one lands in
  // the [boundary, boundary+1s) window (where the chronometer still reads 00:00) even
  // when the phone delays every alarm by up to ~6s — letting us clamp it to a static
  // 00:00:00 before it can ever show a negative value.
  private const val FREEZE_REQUEST_CODE_BASE = 3005
  private val FREEZE_OFFSETS_MILLIS =
    longArrayOf(-5000L, -4000L, -3000L, -2000L, -1000L, 0L, 1100L)

  private val backgroundExecutor = Executors.newSingleThreadExecutor()

  fun startRefresh(context: Context) {
    backgroundExecutor.execute {
      refreshInternal(context.applicationContext)
    }
  }

  fun refreshInternal(context: Context) {
    scheduleMidnightRefresh(context)
    val settings = WidgetSettings.load(context)
    if (!hasLocationOrManualCity(settings)) {
      renderAll(context, "location required", "Next · -- in", null, "--")
      scheduleRetry(context, minutes = 5)
      return
    }

    val prayerTimes = PrayerTimesCache.ensureCurrentData(context)
    if (prayerTimes == null) {
      val fallback = loadLastState(context)
      if (fallback != null) {
        val (lastCurrent, lastNext, lastNextAt) = fallback
        // renderAll keeps the prior countdown running before the boundary and clamps
        // to the ended state at/after it, so it can never tick into the negatives here.
        renderAll(context, lastCurrent, lastNext, lastNextAt, "--")
      } else {
        renderAll(context, "unable to load", "Next · -- in", null, "--")
      }
      scheduleRetry(context, minutes = 5)
      return
    }

    val state = buildWidgetState(prayerTimes)
    val dateText = buildDateText(context, prayerTimes)
    val nextLabel = "Next · ${state.nextPrayer} in"
    saveLastState(context, state.currentPrayer, nextLabel, state.nextPrayerAtMillis)
    renderAll(
      context = context,
      current = "${state.currentPrayer} now",
      next = nextLabel,
      nextPrayerAtMillis = state.nextPrayerAtMillis,
      dateText = dateText
    )

    maybeShowPrayerNotification(context, settings, state)
    scheduleNextPrayerUpdate(context, state.nextPrayerAtMillis)
    scheduleZeroFreeze(context, state.nextPrayerAtMillis)
    scheduleSafetyRefresh(context, state.nextPrayerAtMillis)
  }

  fun freezeAtZero(context: Context) {
    val fallback = loadLastState(context) ?: run {
      startRefresh(context)
      return
    }
    val (lastCurrent, lastNext, lastNextAt) = fallback
    val now = System.currentTimeMillis()

    // Before the boundary the live countdown is still correct — never clamp early.
    if (now < lastNextAt) {
      return
    }

    // At or past the boundary: hard-clamp to a STATIC "00:00:00". Because this is a
    // fixed string and not the self-ticking chronometer, the launcher cannot push it
    // into the negatives no matter how late this alarm actually landed.
    renderAll(context, "$lastCurrent now", lastNext, null, "--", "00:00:00")

    // Hold at zero through the grace second, then advance to the next prayer.
    if (now >= lastNextAt + BOUNDARY_GRACE_MILLIS) {
      startRefresh(context)
    }
  }

  private fun hasLocationOrManualCity(settings: UserSettings): Boolean {
    val hasCoordinates = settings.latitude != null && settings.longitude != null
    val hasCity = settings.city.isNotBlank() && settings.country.isNotBlank()
    return hasCoordinates || hasCity
  }

  private fun buildWidgetState(prayerTimes: PrayerTimes): WidgetState {
    val now = LocalDateTime.now()
    // Subtract the grace so a prayer only becomes "current" once now is past its
    // start time by BOUNDARY_GRACE_SECONDS — the switch happens late, never early.
    val effectiveNow = now.minusSeconds(BOUNDARY_GRACE_SECONDS)
    val today = LocalDate.now()

    val fajr = LocalDateTime.of(today, prayerTimes.fajr)
    val sunrise = LocalDateTime.of(today, prayerTimes.sunrise)
    val dhuhr = LocalDateTime.of(today, prayerTimes.dhuhr)
    val asr = LocalDateTime.of(today, prayerTimes.asr)
    val maghrib = LocalDateTime.of(today, prayerTimes.maghrib)
    val isha = LocalDateTime.of(today, prayerTimes.isha)
    val nextDayFajr = LocalDateTime.of(today.plusDays(1), prayerTimes.fajr)

    val prayerStartMoments = listOf(
      "Fajr" to fajr,
      "Sunrise" to sunrise,
      "Dhuhr" to dhuhr,
      "Asr" to asr,
      "Maghrib" to maghrib,
      "Isha" to isha
    )

    val (currentPrayer, nextPrayer, nextMoment) = when {
      effectiveNow.isBefore(fajr) -> Triple("Isha", "Fajr", fajr)
      effectiveNow.isBefore(sunrise) -> Triple("Fajr", "Sunrise", sunrise)
      effectiveNow.isBefore(dhuhr) -> Triple("Sunrise", "Dhuhr", dhuhr)
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
    val totalSeconds = duration.seconds.coerceAtLeast(0)
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
      val nowMillis = System.currentTimeMillis()
      // Only flip to the "just ended" / next-prayer state once we are a full grace
      // period past the boundary. During the grace second the countdown holds at
      // 00:00:00 on the current prayer (handled by the remaining<=0 branch below),
      // so the next prayer is never surfaced early.
      val shouldShowEndedState =
        nextPrayerAtMillis != null && (nextPrayerAtMillis - nowMillis) <= -BOUNDARY_GRACE_MILLIS

      if (shouldShowEndedState) {
        val currentAsNext = extractNextPrayerName(next) ?: current
        views.setTextViewText(R.id.textCurrentPrayer, currentAsNext)
        views.setTextViewText(R.id.textEndedStatus, "$current time just ended")
        views.setViewVisibility(R.id.textNextPrayer, View.GONE)
        views.setViewVisibility(R.id.textCountdown, View.GONE)
        views.setViewVisibility(R.id.textEndedStatus, View.VISIBLE)
        views.setChronometerCountDown(R.id.textCountdown, false)
        views.setChronometer(R.id.textCountdown, SystemClock.elapsedRealtime(), null, false)
      } else {
        views.setTextViewText(R.id.textCurrentPrayer, current)
        views.setTextViewText(R.id.textNextPrayer, next)
        views.setViewVisibility(R.id.textNextPrayer, View.VISIBLE)
        views.setViewVisibility(R.id.textCountdown, View.VISIBLE)
        views.setViewVisibility(R.id.textEndedStatus, View.GONE)

        if (nextPrayerAtMillis == null) {
          views.setTextViewText(R.id.textCountdown, fixedCountdown ?: "--:--:--")
          views.setChronometerCountDown(R.id.textCountdown, false)
          views.setChronometer(R.id.textCountdown, SystemClock.elapsedRealtime(), null, false)
        } else {
          val remainingMillis = (nextPrayerAtMillis - nowMillis).coerceAtLeast(0L)
          if (remainingMillis <= 0L) {
            views.setTextViewText(R.id.textCountdown, "00:00:00")
            views.setChronometerCountDown(R.id.textCountdown, false)
            views.setChronometer(R.id.textCountdown, SystemClock.elapsedRealtime(), null, false)
          } else {
            val base = SystemClock.elapsedRealtime() + remainingMillis
            views.setChronometerCountDown(R.id.textCountdown, true)
            views.setChronometer(R.id.textCountdown, base, null, true)
          }
        }
      }

      views.setTextViewText(R.id.textDate, dateText)
      attachOpenAppIntent(context, views)

      appWidgetManager.updateAppWidget(id, views)
    }
  }

  private fun extractNextPrayerName(nextLabel: String): String? {
    val regex = Regex("^Next\\s*[·,]\\s*(.+?)\\s+in$")
    return regex.find(nextLabel)?.groupValues?.getOrNull(1)?.trim()?.takeIf { it.isNotEmpty() }
  }

  private fun buildDateText(context: Context, todayTimes: PrayerTimes): String {
    val today = LocalDate.now()
    val todayDay = PrayerTimesCache.getDayForDate(context, today)
    val tomorrowDay = PrayerTimesCache.getDayForDate(context, today.plusDays(1))
    if (todayDay == null) {
      return "--"
    }

    val now = LocalDateTime.now()
    val maghribToday = LocalDateTime.of(today, todayTimes.maghrib)
    val hijri = if (!now.isBefore(maghribToday)) {
      tomorrowDay?.hijriLabel ?: todayDay.hijriLabel
    } else {
      todayDay.hijriLabel
    }
    return hijri
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

  private fun scheduleMidnightRefresh(context: Context) {
    val now = LocalDateTime.now()
    val nextMidnightMillis = now.toLocalDate()
      .plusDays(1)
      .atStartOfDay()
      .atZone(ZoneId.systemDefault())
      .toInstant()
      .toEpochMilli()
    scheduleMidnightAt(context, nextMidnightMillis)
  }

  private fun scheduleZeroFreeze(context: Context, nextPrayerAtMillis: Long) {
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val now = System.currentTimeMillis()

    FREEZE_OFFSETS_MILLIS.forEachIndexed { index, offset ->
      val intent = Intent(context, PrayerUpdateReceiver::class.java).apply {
        action = ACTION_WIDGET_FREEZE_ZERO
      }
      val pendingIntent = PendingIntent.getBroadcast(
        context,
        FREEZE_REQUEST_CODE_BASE + index,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )

      val triggerMillis = nextPrayerAtMillis + offset
      if (triggerMillis <= now + 100L) {
        // Target already in the past (we re-scheduled close to the boundary): drop it.
        alarmManager.cancel(pendingIntent)
      } else {
        scheduleExact(context, AlarmManager.RTC_WAKEUP, triggerMillis, pendingIntent)
      }
    }
  }

  private fun scheduleSafetyRefresh(context: Context, nextPrayerAtMillis: Long) {
    val intent = Intent(context, PrayerUpdateReceiver::class.java).apply {
      action = ACTION_WIDGET_SAFETY_REFRESH
    }
    val pendingIntent = PendingIntent.getBroadcast(
      context,
      3004,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val now = System.currentTimeMillis()
    val remaining = (nextPrayerAtMillis - now).coerceAtLeast(0L)
    // This is only a coarse correctness net now. The exact boundary alarm performs
    // the actual swap; keeping this infrequent avoids burning the per-app Doze
    // allow-while-idle quota, which previously starved the boundary alarm and let
    // the chronometer run past zero into the negatives.
    val interval = if (remaining <= 2L * 60_000L) 60_000L else 5L * 60_000L
    scheduleExact(context, AlarmManager.RTC_WAKEUP, now + interval, pendingIntent)
  }

  private fun scheduleAt(context: Context, triggerMillis: Long) {
    val intent = Intent(context, PrayerUpdateReceiver::class.java).apply {
      action = ACTION_WIDGET_TICK
    }
    val pendingIntent = PendingIntent.getBroadcast(
      context,
      3001,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val safeTrigger = triggerMillis.coerceAtLeast(System.currentTimeMillis() + 1000L)
    scheduleExact(context, AlarmManager.RTC_WAKEUP, safeTrigger, pendingIntent)
  }

  private fun scheduleMidnightAt(context: Context, triggerMillis: Long) {
    val intent = Intent(context, PrayerUpdateReceiver::class.java).apply {
      action = ACTION_WIDGET_MIDNIGHT_REFRESH
    }
    val pendingIntent = PendingIntent.getBroadcast(
      context,
      3003,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val safeTrigger = triggerMillis.coerceAtLeast(System.currentTimeMillis() + 1000L)
    scheduleExact(context, AlarmManager.RTC_WAKEUP, safeTrigger, pendingIntent)
  }

  /**
   * Schedules a wake-up that fires on time even in Doze. With USE_EXACT_ALARM the
   * device grants exact scheduling, so the boundary refresh is no longer silently
   * downgraded to an inexact (heavily deferred) alarm. If exact scheduling is ever
   * unavailable we fall back to an inexact allow-while-idle alarm; the zero-clamp
   * still guarantees the countdown never displays a negative value.
   */
  private fun scheduleExact(
    context: Context,
    type: Int,
    triggerMillis: Long,
    pendingIntent: PendingIntent
  ) {
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    alarmManager.cancel(pendingIntent)

    val canScheduleExact = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      alarmManager.canScheduleExactAlarms()
    } else {
      true
    }

    try {
      if (canScheduleExact) {
        alarmManager.setExactAndAllowWhileIdle(type, triggerMillis, pendingIntent)
      } else {
        alarmManager.setAndAllowWhileIdle(type, triggerMillis, pendingIntent)
      }
    } catch (_: SecurityException) {
      alarmManager.setAndAllowWhileIdle(type, triggerMillis, pendingIntent)
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

    val midnightIntent = Intent(context, PrayerUpdateReceiver::class.java).apply {
      action = ACTION_WIDGET_MIDNIGHT_REFRESH
    }
    val midnightPendingIntent = PendingIntent.getBroadcast(
      context,
      3003,
      midnightIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    alarmManager.cancel(midnightPendingIntent)

    val safetyIntent = Intent(context, PrayerUpdateReceiver::class.java).apply {
      action = ACTION_WIDGET_SAFETY_REFRESH
    }
    val safetyPendingIntent = PendingIntent.getBroadcast(
      context,
      3004,
      safetyIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    alarmManager.cancel(safetyPendingIntent)

    FREEZE_OFFSETS_MILLIS.indices.forEach { index ->
      val freezeIntent = Intent(context, PrayerUpdateReceiver::class.java).apply {
        action = ACTION_WIDGET_FREEZE_ZERO
      }
      val freezePendingIntent = PendingIntent.getBroadcast(
        context,
        FREEZE_REQUEST_CODE_BASE + index,
        freezeIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      alarmManager.cancel(freezePendingIntent)
    }
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
