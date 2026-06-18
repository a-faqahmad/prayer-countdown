export type HijriMethod = 'HJCoSA' | 'UAQ' | 'MATHEMATICAL';

export type WidgetDisplayMode = 'time' | 'countdown';

export type AppSettings = {
  city: string;
  country: string;
  latitude: number | null;
  longitude: number | null;
  useDeviceLocation: boolean;
  school: number;
  notificationsEnabled: boolean;
  widgetEnabled: boolean;
  hijriCalendarMethod: HijriMethod;
  hijriMethodAuto: boolean;
  hijriAdjustment: number;
  widgetDisplayMode: WidgetDisplayMode;
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
  hijriCalendarMethod: 'HJCoSA',
  hijriMethodAuto: true,
  hijriAdjustment: 0,
  widgetDisplayMode: 'time',
};
