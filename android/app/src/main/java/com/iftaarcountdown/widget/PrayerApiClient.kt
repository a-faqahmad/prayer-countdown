package com.iftaarcountdown.widget

import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URLEncoder
import java.net.URL
import java.nio.charset.StandardCharsets
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter

data class PrayerTimes(
  val fajr: LocalTime,
  val sunrise: LocalTime,
  val dhuhr: LocalTime,
  val asr: LocalTime,
  val maghrib: LocalTime,
  val isha: LocalTime
)

data class PrayerDay(
  val times: PrayerTimes,
  val hijriLabel: String,
  val gregorianLabel: String
)

object PrayerApiClient {
  private const val TAG = "PrayerApiClient"
  private val timeParser: DateTimeFormatter = DateTimeFormatter.ofPattern("H:mm")
  private val dateParser: DateTimeFormatter = DateTimeFormatter.ofPattern("dd-MM-yyyy")

  fun getPrayerTimes(settings: UserSettings): PrayerTimes? {
    return getPrayerTimesForDate(settings, LocalDate.now())
  }

  fun getPrayerTimesForDate(settings: UserSettings, date: LocalDate): PrayerTimes? {
    return getPrayerDayForDate(settings, date)?.times
  }

  fun getPrayerDayForDate(settings: UserSettings, date: LocalDate): PrayerDay? {
    return try {
      val endpoint = buildUrl(settings, date)
      val response = fetch(endpoint)
      parsePrayerDay(response)
    } catch (error: Exception) {
      Log.e(TAG, "Failed to load prayer times", error)
      null
    }
  }

  private fun buildUrl(settings: UserSettings, date: LocalDate): String {
    val method = 1
    val dateString = date.format(dateParser)

    return if (settings.useDeviceLocation && settings.latitude != null && settings.longitude != null) {
      "https://api.aladhan.com/v1/timings/$dateString?latitude=${settings.latitude}&longitude=${settings.longitude}&method=$method&school=${settings.school}"
    } else {
      val city = URLEncoder.encode(settings.city, StandardCharsets.UTF_8.toString())
      val country = URLEncoder.encode(settings.country, StandardCharsets.UTF_8.toString())
      "https://api.aladhan.com/v1/timingsByCity/$dateString?city=$city&country=$country&method=$method&school=${settings.school}"
    }
  }

  private fun fetch(endpoint: String): String {
    val connection = URL(endpoint).openConnection() as HttpURLConnection
    connection.requestMethod = "GET"
    connection.connectTimeout = 15000
    connection.readTimeout = 15000

    return connection.inputStream.bufferedReader().use { it.readText() }
  }

  private fun parsePrayerDay(json: String): PrayerDay {
    val root = JSONObject(json)
    val data = root.getJSONObject("data")
    val timings = data.getJSONObject("timings")
    val date = data.getJSONObject("date")
    val gregorian = date.getJSONObject("gregorian")
    val hijri = date.getJSONObject("hijri")
    val hijriMonth = hijri.getJSONObject("month").getString("en")
    val gregMonth = gregorian.getJSONObject("month").getString("en")

    return PrayerDay(
      times = PrayerTimes(
        fajr = parseTime(timings.getString("Fajr")),
        sunrise = parseTime(timings.getString("Sunrise")),
        dhuhr = parseTime(timings.getString("Dhuhr")),
        asr = parseTime(timings.getString("Asr")),
        maghrib = parseTime(timings.getString("Maghrib")),
        isha = parseTime(timings.getString("Isha"))
      ),
      hijriLabel = "${hijri.getString("day")} $hijriMonth ${hijri.getString("year")} AH",
      gregorianLabel = "${gregorian.getString("day")} $gregMonth ${gregorian.getString("year")}"
    )
  }

  private fun parseTime(value: String): LocalTime {
    val normalized = value.split(" ")[0].trim()
    return LocalTime.parse(normalized, timeParser)
  }
}
