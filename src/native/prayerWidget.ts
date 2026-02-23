import {NativeEventEmitter, NativeModules} from 'react-native';
import {AppSettings, DEFAULT_SETTINGS, DetectedLocation} from '../types/settings';

type Coordinates = {
  latitude: number;
  longitude: number;
};

export type PrayerTimes = {
  fajr: string;
  sunrise: string;
  dhuhr: string;
  asr: string;
  maghrib: string;
  isha: string;
  hijri?: string;
  gregorian?: string;
};

type PrayerWidgetModuleType = {
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<boolean>;
  refreshWidget: () => Promise<boolean>;
  detectLocation: () => Promise<DetectedLocation>;
  resolveCoordinates: (city: string, country: string) => Promise<Coordinates>;
  getQiblaDirection: (latitude: number, longitude: number) => Promise<number>;
  startCompass: () => Promise<boolean>;
  stopCompass: () => Promise<boolean>;
  syncPrayerCache: () => Promise<boolean>;
  getTodayPrayerTimes: () => Promise<PrayerTimes>;
  getPrayerTimesForDate: (dateIso: string) => Promise<PrayerTimes>;
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
};

const NativePrayerWidget =
  NativeModules.PrayerWidgetModule as PrayerWidgetModuleType;

export async function getSettings(): Promise<AppSettings> {
  if (!NativePrayerWidget) {
    return DEFAULT_SETTINGS;
  }
  return NativePrayerWidget.getSettings();
}

export async function saveSettings(settings: AppSettings): Promise<boolean> {
  if (!NativePrayerWidget) {
    return true;
  }
  return NativePrayerWidget.saveSettings(settings);
}

export async function refreshWidget(): Promise<boolean> {
  if (!NativePrayerWidget) {
    return true;
  }
  return NativePrayerWidget.refreshWidget();
}

export async function detectLocation(): Promise<DetectedLocation> {
  if (!NativePrayerWidget) {
    throw new Error('Location detection is only available on Android.');
  }
  return NativePrayerWidget.detectLocation();
}

export async function resolveCoordinates(
  city: string,
  country: string,
): Promise<Coordinates> {
  if (!NativePrayerWidget) {
    throw new Error('Geocoding is only available on Android.');
  }
  return NativePrayerWidget.resolveCoordinates(city, country);
}

export async function getQiblaDirection(
  latitude: number,
  longitude: number,
): Promise<number> {
  if (!NativePrayerWidget) {
    throw new Error('Qibla direction is only available on Android.');
  }
  return NativePrayerWidget.getQiblaDirection(latitude, longitude);
}

export async function startCompass(): Promise<boolean> {
  if (!NativePrayerWidget) {
    throw new Error('Compass is only available on Android.');
  }
  return NativePrayerWidget.startCompass();
}

export async function stopCompass(): Promise<boolean> {
  if (!NativePrayerWidget) {
    return true;
  }
  return NativePrayerWidget.stopCompass();
}

export async function syncPrayerCache(): Promise<boolean> {
  if (!NativePrayerWidget) {
    return false;
  }
  return NativePrayerWidget.syncPrayerCache();
}

export async function getTodayPrayerTimes(): Promise<PrayerTimes> {
  if (!NativePrayerWidget) {
    throw new Error('Prayer times cache is only available on Android.');
  }
  return NativePrayerWidget.getTodayPrayerTimes();
}

export async function getPrayerTimesForDate(
  dateIso: string,
): Promise<PrayerTimes> {
  if (!NativePrayerWidget) {
    throw new Error('Prayer times cache is only available on Android.');
  }
  return NativePrayerWidget.getPrayerTimesForDate(dateIso);
}

export function getCompassEmitter(): NativeEventEmitter | null {
  if (!NativePrayerWidget) {
    return null;
  }
  return new NativeEventEmitter(NativePrayerWidget);
}
