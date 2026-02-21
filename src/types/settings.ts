export type AppSettings = {
  city: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  useDeviceLocation: boolean;
  school: number;
  notificationsEnabled: boolean;
  widgetEnabled: boolean;
};

export type DetectedLocation = {
  city: string;
  country: string;
  latitude: number;
  longitude: number;
};

export const DEFAULT_SETTINGS: AppSettings = {
  city: '',
  country: '',
  latitude: null,
  longitude: null,
  useDeviceLocation: true,
  school: 1,
  notificationsEnabled: false,
  widgetEnabled: true,
};
