package com.iftaarcountdown

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Geocoder
import android.location.Location
import android.location.LocationManager
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.iftaarcountdown.widget.PrayerWidgetUpdater
import com.iftaarcountdown.widget.PrayerTimes
import com.iftaarcountdown.widget.PrayerTimesCache
import com.iftaarcountdown.widget.WidgetSettings
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.Executors
import kotlin.math.roundToInt

class PrayerWidgetModule(private val reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext), SensorEventListener {

  private val executor = Executors.newSingleThreadExecutor()
  private val sensorManager = reactContext.getSystemService(Context.SENSOR_SERVICE) as SensorManager
  private val rotationSensor: Sensor? = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
  private var compassActive = false
  private var listenerCount = 0

  override fun getName(): String {
    return "PrayerWidgetModule"
  }

  @ReactMethod
  fun getSettings(promise: Promise) {
    try {
      val settings = WidgetSettings.load(reactContext)
      val data = Arguments.createMap().apply {
        putString("city", settings.city)
        putString("country", settings.country)
        if (settings.latitude != null) {
          putDouble("latitude", settings.latitude)
        }
        if (settings.longitude != null) {
          putDouble("longitude", settings.longitude)
        }
        putBoolean("useDeviceLocation", settings.useDeviceLocation)
        putInt("school", settings.school)
        putBoolean("notificationsEnabled", settings.notificationsEnabled)
        putBoolean("widgetEnabled", settings.widgetEnabled)
      }
      promise.resolve(data)
    } catch (error: Exception) {
      promise.reject("SETTINGS_ERROR", error)
    }
  }

  @ReactMethod
  fun saveSettings(input: ReadableMap, promise: Promise) {
    try {
      val city = if (input.hasKey("city")) input.getString("city") ?: "" else ""
      val country = if (input.hasKey("country")) input.getString("country") ?: "" else ""
      val latitude = if (input.hasKey("latitude") && !input.isNull("latitude")) input.getDouble("latitude") else null
      val longitude = if (input.hasKey("longitude") && !input.isNull("longitude")) input.getDouble("longitude") else null
      val useDeviceLocation = if (input.hasKey("useDeviceLocation")) input.getBoolean("useDeviceLocation") else true
      val school = if (input.hasKey("school")) input.getInt("school") else 1
      val notificationsEnabled = if (input.hasKey("notificationsEnabled")) input.getBoolean("notificationsEnabled") else false
      val widgetEnabled = if (input.hasKey("widgetEnabled")) input.getBoolean("widgetEnabled") else true

      WidgetSettings.save(
        context = reactContext,
        city = city,
        country = country,
        latitude = latitude,
        longitude = longitude,
        useDeviceLocation = useDeviceLocation,
        school = school,
        notificationsEnabled = notificationsEnabled,
        widgetEnabled = widgetEnabled
      )

      PrayerTimesCache.syncNow(reactContext)
      PrayerTimesCache.scheduleNextMidnightSync(reactContext)
      PrayerWidgetUpdater.startRefresh(reactContext)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("SAVE_ERROR", error)
    }
  }

  @ReactMethod
  fun refreshWidget(promise: Promise) {
    try {
      PrayerTimesCache.scheduleNextMidnightSync(reactContext)
      PrayerWidgetUpdater.startRefresh(reactContext)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("WIDGET_REFRESH_ERROR", error)
    }
  }

  @ReactMethod
  fun detectLocation(promise: Promise) {
    val hasFine = ContextCompat.checkSelfPermission(
      reactContext,
      Manifest.permission.ACCESS_FINE_LOCATION
    ) == PackageManager.PERMISSION_GRANTED

    val hasCoarse = ContextCompat.checkSelfPermission(
      reactContext,
      Manifest.permission.ACCESS_COARSE_LOCATION
    ) == PackageManager.PERMISSION_GRANTED

    if (!hasFine && !hasCoarse) {
      promise.reject("LOCATION_PERMISSION_DENIED", "Location permission denied")
      return
    }

    executor.execute {
      try {
        val location = getBestLastKnownLocation() ?: run {
          promise.reject("LOCATION_UNAVAILABLE", "Unable to determine location")
          return@execute
        }

        val reverse = reverseGeocode(location.latitude, location.longitude)
        val data = Arguments.createMap().apply {
          putDouble("latitude", location.latitude)
          putDouble("longitude", location.longitude)
          putString("city", reverse.first)
          putString("country", reverse.second)
        }
        promise.resolve(data)
      } catch (error: Exception) {
        promise.reject("LOCATION_ERROR", error)
      }
    }
  }

  @ReactMethod
  fun syncPrayerCache(promise: Promise) {
    executor.execute {
      try {
        val success = PrayerTimesCache.syncNow(reactContext)
        PrayerTimesCache.scheduleNextMidnightSync(reactContext)
        PrayerWidgetUpdater.startRefresh(reactContext)
        promise.resolve(success)
      } catch (error: Exception) {
        promise.reject("CACHE_SYNC_ERROR", error)
      }
    }
  }

  @ReactMethod
  fun getTodayPrayerTimes(promise: Promise) {
    executor.execute {
      try {
        val timings = PrayerTimesCache.ensureCurrentData(reactContext)
        if (timings == null) {
          promise.reject("PRAYER_TIMES_UNAVAILABLE", "Prayer times not available")
          return@execute
        }
        val day = PrayerTimesCache.getDayForDate(reactContext, java.time.LocalDate.now())
        promise.resolve(toReadableMap(timings, day?.hijriLabel ?: "", day?.gregorianLabel ?: ""))
      } catch (error: Exception) {
        promise.reject("PRAYER_TIMES_ERROR", error)
      }
    }
  }

  @ReactMethod
  fun getPrayerTimesForDate(dateIso: String, promise: Promise) {
    executor.execute {
      try {
        val date = java.time.LocalDate.parse(dateIso)
        val day = PrayerTimesCache.getDayForDate(reactContext, date)
        if (day == null) {
          promise.reject("PRAYER_TIMES_NOT_FOUND", "No prayer timings for this date")
          return@execute
        }
        promise.resolve(toReadableMap(day.times, day.hijriLabel, day.gregorianLabel))
      } catch (error: Exception) {
        promise.reject("PRAYER_TIMES_ERROR", error)
      }
    }
  }

  @ReactMethod
  fun resolveCoordinates(city: String, country: String, promise: Promise) {
    executor.execute {
      try {
        val geocoder = Geocoder(reactContext, Locale.getDefault())
        val query = "$city, $country"
        val addresses = geocoder.getFromLocationName(query, 1)
        val address = addresses?.firstOrNull()

        if (address == null) {
          promise.reject("GEOCODE_NOT_FOUND", "Could not resolve location")
          return@execute
        }

        val data = Arguments.createMap().apply {
          putDouble("latitude", address.latitude)
          putDouble("longitude", address.longitude)
        }
        promise.resolve(data)
      } catch (error: Exception) {
        promise.reject("GEOCODE_ERROR", error)
      }
    }
  }

  @ReactMethod
  fun getQiblaDirection(latitude: Double, longitude: Double, promise: Promise) {
    executor.execute {
      try {
        val endpoint = "https://api.aladhan.com/v1/qibla/$latitude/$longitude"
        val connection = URL(endpoint).openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = 15000
        connection.readTimeout = 15000

        val response = connection.inputStream.bufferedReader().use { it.readText() }
        val root = JSONObject(response)
        val direction = root.getJSONObject("data").getDouble("direction")
        promise.resolve(direction)
      } catch (error: Exception) {
        promise.reject("QIBLA_ERROR", error)
      }
    }
  }

  @ReactMethod
  fun startCompass(promise: Promise) {
    if (rotationSensor == null) {
      promise.reject("COMPASS_NOT_AVAILABLE", "Compass sensor unavailable")
      return
    }

    if (compassActive) {
      promise.resolve(true)
      return
    }

    compassActive = sensorManager.registerListener(
      this,
      rotationSensor,
      SensorManager.SENSOR_DELAY_GAME
    )

    if (compassActive) {
      promise.resolve(true)
    } else {
      promise.reject("COMPASS_START_FAILED", "Could not start compass")
    }
  }

  @ReactMethod
  fun stopCompass(promise: Promise) {
    if (compassActive) {
      sensorManager.unregisterListener(this)
      compassActive = false
    }
    promise.resolve(true)
  }

  @ReactMethod
  fun addListener(eventName: String) {
    listenerCount += 1
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    listenerCount = (listenerCount - count).coerceAtLeast(0)
  }

  override fun onSensorChanged(event: SensorEvent?) {
    if (!compassActive || listenerCount <= 0 || event?.sensor?.type != Sensor.TYPE_ROTATION_VECTOR) {
      return
    }

    val rotation = FloatArray(9)
    val orientation = FloatArray(3)
    SensorManager.getRotationMatrixFromVector(rotation, event.values)
    SensorManager.getOrientation(rotation, orientation)

    val azimuth = Math.toDegrees(orientation[0].toDouble())
    val heading = ((azimuth + 360.0) % 360.0 * 10.0).roundToInt() / 10.0

    val data = Arguments.createMap().apply {
      putDouble("heading", heading)
    }
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("compassHeadingChanged", data)
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
    // No-op.
  }

  override fun invalidate() {
    if (compassActive) {
      sensorManager.unregisterListener(this)
      compassActive = false
    }
    super.invalidate()
  }

  private fun getBestLastKnownLocation(): Location? {
    val manager = reactContext.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val providers = manager.getProviders(true)

    var best: Location? = null
    for (provider in providers) {
      val location = try {
        manager.getLastKnownLocation(provider)
      } catch (_: SecurityException) {
        null
      }

      if (location != null && (best == null || location.accuracy < best.accuracy)) {
        best = location
      }
    }

    return best
  }

  private fun reverseGeocode(latitude: Double, longitude: Double): Pair<String, String> {
    val geocoder = Geocoder(reactContext, Locale.getDefault())
    val addresses = geocoder.getFromLocation(latitude, longitude, 1)
    val address = addresses?.firstOrNull()

    val city = address?.locality ?: address?.subAdminArea ?: address?.adminArea ?: ""
    val country = address?.countryName ?: ""
    return city to country
  }

  private fun toReadableMap(value: PrayerTimes, hijri: String, gregorian: String) = Arguments.createMap().apply {
    putString("fajr", value.fajr.format(java.time.format.DateTimeFormatter.ofPattern("HH:mm")))
    putString("dhuhr", value.dhuhr.format(java.time.format.DateTimeFormatter.ofPattern("HH:mm")))
    putString("asr", value.asr.format(java.time.format.DateTimeFormatter.ofPattern("HH:mm")))
    putString("maghrib", value.maghrib.format(java.time.format.DateTimeFormatter.ofPattern("HH:mm")))
    putString("isha", value.isha.format(java.time.format.DateTimeFormatter.ofPattern("HH:mm")))
    putString("hijri", hijri)
    putString("gregorian", gregorian)
  }
}
