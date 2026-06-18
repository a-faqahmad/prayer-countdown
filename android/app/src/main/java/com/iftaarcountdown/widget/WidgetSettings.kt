package com.iftaarcountdown.widget

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit

data class UserSettings(
  val city: String,
  val country: String,
  val latitude: Double?,
  val longitude: Double?,
  val useDeviceLocation: Boolean,
  val school: Int,
  val notificationsEnabled: Boolean,
  val widgetEnabled: Boolean,
  val hijriCalendarMethod: String,
  val hijriMethodAuto: Boolean,
  val hijriAdjustment: Int,
  val lastNotificationKey: String
)

object WidgetSettings {
  private const val PREFS_NAME = "prayer_widget_settings"
  private const val KEY_CITY = "city"
  private const val KEY_COUNTRY = "country"
  private const val KEY_LATITUDE = "latitude"
  private const val KEY_LONGITUDE = "longitude"
  private const val KEY_USE_DEVICE_LOCATION = "use_device_location"
  private const val KEY_SCHOOL = "school"
  private const val KEY_NOTIFICATIONS_ENABLED = "notifications_enabled"
  private const val KEY_WIDGET_ENABLED = "widget_enabled"
  private const val KEY_HIJRI_METHOD = "hijri_calendar_method"
  private const val KEY_HIJRI_METHOD_AUTO = "hijri_method_auto"
  private const val KEY_HIJRI_ADJUSTMENT = "hijri_adjustment"
  private const val KEY_LAST_NOTIFICATION = "last_notification"

  const val DEFAULT_HIJRI_METHOD = "HJCoSA"

  private fun prefs(context: Context): SharedPreferences {
    return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
  }

  fun load(context: Context): UserSettings {
    val sharedPrefs = prefs(context)
    val lat = if (sharedPrefs.contains(KEY_LATITUDE)) sharedPrefs.getString(KEY_LATITUDE, null)?.toDoubleOrNull() else null
    val lon = if (sharedPrefs.contains(KEY_LONGITUDE)) sharedPrefs.getString(KEY_LONGITUDE, null)?.toDoubleOrNull() else null

    return UserSettings(
      city = sharedPrefs.getString(KEY_CITY, "") ?: "",
      country = sharedPrefs.getString(KEY_COUNTRY, "") ?: "",
      latitude = lat,
      longitude = lon,
      useDeviceLocation = sharedPrefs.getBoolean(KEY_USE_DEVICE_LOCATION, true),
      school = sharedPrefs.getInt(KEY_SCHOOL, 1),
      notificationsEnabled = sharedPrefs.getBoolean(KEY_NOTIFICATIONS_ENABLED, false),
      widgetEnabled = sharedPrefs.getBoolean(KEY_WIDGET_ENABLED, true),
      hijriCalendarMethod = sharedPrefs.getString(KEY_HIJRI_METHOD, DEFAULT_HIJRI_METHOD) ?: DEFAULT_HIJRI_METHOD,
      hijriMethodAuto = sharedPrefs.getBoolean(KEY_HIJRI_METHOD_AUTO, true),
      hijriAdjustment = sharedPrefs.getInt(KEY_HIJRI_ADJUSTMENT, 0),
      lastNotificationKey = sharedPrefs.getString(KEY_LAST_NOTIFICATION, "") ?: ""
    )
  }

  fun save(
    context: Context,
    city: String,
    country: String,
    latitude: Double?,
    longitude: Double?,
    useDeviceLocation: Boolean,
    school: Int,
    notificationsEnabled: Boolean,
    widgetEnabled: Boolean,
    hijriCalendarMethod: String,
    hijriMethodAuto: Boolean,
    hijriAdjustment: Int
  ) {
    prefs(context).edit {
      putString(KEY_CITY, city.trim())
      putString(KEY_COUNTRY, country.trim())
      if (latitude == null || longitude == null) {
        remove(KEY_LATITUDE)
        remove(KEY_LONGITUDE)
      } else {
        putString(KEY_LATITUDE, latitude.toString())
        putString(KEY_LONGITUDE, longitude.toString())
      }
      putBoolean(KEY_USE_DEVICE_LOCATION, useDeviceLocation)
      putInt(KEY_SCHOOL, school)
      putBoolean(KEY_NOTIFICATIONS_ENABLED, notificationsEnabled)
      putBoolean(KEY_WIDGET_ENABLED, widgetEnabled)
      putString(KEY_HIJRI_METHOD, hijriCalendarMethod)
      putBoolean(KEY_HIJRI_METHOD_AUTO, hijriMethodAuto)
      putInt(KEY_HIJRI_ADJUSTMENT, hijriAdjustment)
    }
  }

  fun saveLastNotification(context: Context, key: String) {
    prefs(context).edit { putString(KEY_LAST_NOTIFICATION, key) }
  }
}
