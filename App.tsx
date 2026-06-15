import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Modal,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import {CITY_OPTIONS} from './src/data/cities';
import {
  detectLocation,
  getCompassEmitter,
  getPrayerTimesForDate,
  getQiblaDirection,
  getSettings,
  getTodayPrayerTimes,
  PrayerTimes,
  refreshWidget,
  resolveCoordinates,
  saveSettings,
  syncPrayerCache,
  startCompass,
  stopCompass,
} from './src/native/prayerWidget';
import {AppSettings, DEFAULT_SETTINGS} from './src/types/settings';

type PrayerPanelState = 'loading' | 'ready' | 'location_required' | 'error';

const C = {
  canvas: '#EEF3F0',
  card: '#FFFFFF',
  ink: '#14241D',
  inkSoft: '#5C6B63',
  inkFaint: '#8C9890',
  line: '#F0F3F1',
  primary: '#0D6E4C',
  primaryBright: '#15A472',
  mint: '#E7F5EE',
  mintInk: '#0B6B49',
  blueTint: '#E8F0FE',
  amberTint: '#FBF0E1',
  trackOff: '#D8DEDB',
};

function IconBadge({glyph, tint}: {glyph: string; tint: string}): React.JSX.Element {
  return (
    <View style={[styles.iconBadge, {backgroundColor: tint}]}>
      <Text style={styles.iconBadgeGlyph}>{glyph}</Text>
    </View>
  );
}

function App(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [qiblaVisible, setQiblaVisible] = useState(false);
  const [qiblaLoading, setQiblaLoading] = useState(false);
  const [qiblaHeading, setQiblaHeading] = useState(0);
  const [qiblaDirection, setQiblaDirection] = useState<number | null>(null);
  const [locationEditorVisible, setLocationEditorVisible] = useState(false);
  const [widgetHelpVisible, setWidgetHelpVisible] = useState(false);
  const [allPrayerTimesVisible, setAllPrayerTimesVisible] = useState(false);
  const [prayerTimes, setPrayerTimes] = useState<PrayerTimes | null>(null);
  const [currentPrayerName, setCurrentPrayerName] = useState('--');
  const [nextPrayerName, setNextPrayerName] = useState('--');
  const [nextPrayerCountdown, setNextPrayerCountdown] = useState('--:--:--');
  const [dateFooterText, setDateFooterText] = useState('--');
  const [locationSetupResolved, setLocationSetupResolved] = useState(false);
  const [prayerPanelState, setPrayerPanelState] =
    useState<PrayerPanelState>('loading');
  const autoLocationCheckedRef = useRef(false);
  const notificationInitAttemptedRef = useRef(false);
  const lastPersistedSettingsRef = useRef('');
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const compassEmitter = useMemo(() => getCompassEmitter(), []);

  useEffect(() => {
    const load = async () => {
      try {
        const stored = await getSettings();
        const normalized = {
          ...DEFAULT_SETTINGS,
          ...stored,
          latitude: stored.latitude ?? null,
          longitude: stored.longitude ?? null,
          widgetEnabled: true,
        };
        setSettings(normalized);
        lastPersistedSettingsRef.current = serializeSettings(normalized);
        setSearchQuery(
          stored.city && stored.country ? `${stored.city}, ${stored.country}` : '',
        );
        await syncPrayerCache();
        await refreshWidget();
      } catch (error) {
        console.error(error);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  useEffect(() => {
    if (loading) {
      return;
    }

    const normalized: AppSettings = {
      ...settings,
      city: settings.city.trim(),
      country: settings.country.trim(),
      widgetEnabled: true,
    };
    const serialized = serializeSettings(normalized);
    if (serialized === lastPersistedSettingsRef.current) {
      return;
    }

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = setTimeout(async () => {
      try {
        await saveSettings(normalized);
        await syncPrayerCache();
        await refreshWidget();
        lastPersistedSettingsRef.current = serialized;
      } catch (error) {
        console.error(error);
      }
    }, 350);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [loading, settings]);

  useEffect(() => {
    if (loading || autoLocationCheckedRef.current) {
      return;
    }

    if (Platform.OS !== 'android') {
      autoLocationCheckedRef.current = true;
      setLocationSetupResolved(true);
      return;
    }

    if (hasConfiguredLocation(settings)) {
      autoLocationCheckedRef.current = true;
      setLocationSetupResolved(true);
      return;
    }

    autoLocationCheckedRef.current = true;
    const autoDetect = async () => {
      setPrayerPanelState('loading');
      setDetecting(true);

      try {
        const granted = await requestLocationPermission();
        if (!granted) {
          setPrayerPanelState('location_required');
          return;
        }

        const detected = await detectLocation();
        const updatedSettings: AppSettings = {
          ...settings,
          city: detected.city,
          country: detected.country,
          latitude: detected.latitude,
          longitude: detected.longitude,
          useDeviceLocation: true,
          widgetEnabled: true,
        };
        setSettings(updatedSettings);
        setSearchQuery(
          detected.city ? `${detected.city}, ${detected.country}` : '',
        );
        await saveSettings(updatedSettings);
        await refreshWidget();
      } catch (error) {
        console.error(error);
        setPrayerPanelState('location_required');
      } finally {
        setDetecting(false);
        setLocationSetupResolved(true);
      }
    };

    autoDetect();
  }, [loading, settings]);

  useEffect(() => {
    if (loading || !locationSetupResolved || notificationInitAttemptedRef.current) {
      return;
    }

    if (Platform.OS !== 'android') {
      notificationInitAttemptedRef.current = true;
      return;
    }

    const ensureNotificationPermission = async () => {
      const sdkVersion =
        typeof Platform.Version === 'number' ? Platform.Version : 0;
      if (sdkVersion < 33) {
        if (!settings.notificationsEnabled) {
          updateField('notificationsEnabled', true);
        }
        notificationInitAttemptedRef.current = true;
        return;
      }

      const alreadyGranted = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
      );
      if (alreadyGranted) {
        if (!settings.notificationsEnabled) {
          updateField('notificationsEnabled', true);
        }
        setErrorMessage('');
        notificationInitAttemptedRef.current = true;
        return;
      }

      const granted = await requestNotificationPermission();
      if (granted) {
        updateField('notificationsEnabled', true);
        setErrorMessage('');
      } else {
        updateField('notificationsEnabled', false);
        setErrorMessage(
          'Please grant notifications access to application in your settings.',
        );
      }
      notificationInitAttemptedRef.current = true;
    };

    ensureNotificationPermission().catch(error => {
      console.error(error);
      notificationInitAttemptedRef.current = true;
    });
  }, [loading, locationSetupResolved, settings.notificationsEnabled]);

  useEffect(() => {
    if (!qiblaVisible) {
      return;
    }

    let subscription: {remove: () => void} | undefined;

    const activateCompass = async () => {
      try {
        if (compassEmitter) {
          subscription = compassEmitter.addListener('compassHeadingChanged', event => {
            const heading = Number(event?.heading);
            if (!Number.isNaN(heading)) {
              setQiblaHeading(heading);
            }
          });
        }

        await startCompass();
      } catch (error) {
        console.error(error);
        setErrorMessage('Compass sensor is not available on this device.');
      }
    };

    activateCompass();

    return () => {
      subscription?.remove();
      stopCompass().catch(error => {
        console.error(error);
      });
    };
  }, [compassEmitter, qiblaVisible]);

  useEffect(() => {
    const loadPrayerTimes = async (runSync: boolean = false) => {
      setPrayerPanelState('loading');
      try {
        if (
          !(
            (settings.latitude !== null && settings.longitude !== null) ||
            (settings.city.trim() && settings.country.trim())
          )
        ) {
          setPrayerTimes(null);
          setCurrentPrayerName('--');
          setNextPrayerName('--');
          setNextPrayerCountdown('--:--:--');
          setPrayerPanelState('location_required');
          return;
        }
        if (runSync) {
          await syncPrayerCache();
        }

        const timings = await getTodayPrayerTimes();
        setPrayerTimes(timings);
        const tomorrowIso = getDateIsoOffset(1);
        const tomorrow = await getPrayerTimesForDate(tomorrowIso).catch(() => null);
        setDateFooterText(buildDateFooterText(timings, tomorrow));
        setPrayerPanelState('ready');
      } catch (error) {
        console.error(error);
        setPrayerTimes(null);
        setCurrentPrayerName('--');
        setNextPrayerName('--');
        setNextPrayerCountdown('--:--:--');
        setDateFooterText('--');
        setPrayerPanelState('error');
      }
    };

    loadPrayerTimes(true);
    const id = setInterval(() => {
      loadPrayerTimes(false);
    }, 60 * 1000);

    return () => clearInterval(id);
  }, [
    settings.city,
    settings.country,
    settings.latitude,
    settings.longitude,
    settings.school,
  ]);

  useEffect(() => {
    if (!prayerTimes) {
      return;
    }

    const tick = () => {
      const snapshot = getPrayerSnapshot(prayerTimes, new Date());
      setCurrentPrayerName(snapshot.currentPrayer);
      setNextPrayerName(snapshot.nextPrayer);
      setNextPrayerCountdown(snapshot.countdown);
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [prayerTimes]);

  const filteredCities = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) {
      return [];
    }

    return CITY_OPTIONS.filter(option => {
      const cityText = option.city.toLowerCase();
      const countryText = option.country.toLowerCase();
      return cityText.includes(query) || countryText.includes(query);
    }).slice(0, 10);
  }, [searchQuery]);

  const locationSummary = useMemo(() => {
    if (settings.city && settings.country) {
      return `${settings.city}, ${settings.country}`;
    }
    if (settings.latitude !== null && settings.longitude !== null) {
      return `${settings.latitude.toFixed(3)}, ${settings.longitude.toFixed(3)}`;
    }
    return 'Not configured';
  }, [settings]);

  const updateField = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) => {
    setSettings(prev => ({...prev, [key]: value}));
  };

  const requestLocationPermission = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') {
      return true;
    }

    const response = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
    ]);

    const fineGranted =
      response[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] ===
      PermissionsAndroid.RESULTS.GRANTED;
    const coarseGranted =
      response[PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION] ===
      PermissionsAndroid.RESULTS.GRANTED;

    return fineGranted || coarseGranted;
  };

  const requestNotificationPermission = async (): Promise<boolean> => {
    if (Platform.OS !== 'android') {
      return true;
    }

    const sdkVersion =
      typeof Platform.Version === 'number' ? Platform.Version : 0;
    if (sdkVersion < 33) {
      return true;
    }

    const status = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
    );

    return status === PermissionsAndroid.RESULTS.GRANTED;
  };

  const onDetectLocation = async () => {
    setErrorMessage('');
    setSuccessMessage('');
    setPrayerPanelState('loading');
    setDetecting(true);

    try {
      const granted = await requestLocationPermission();
      if (!granted) {
        setPrayerPanelState('location_required');
        setErrorMessage('Location permission denied. Please select city manually.');
        return;
      }

      const detected = await detectLocation();
      const updatedSettings: AppSettings = {
        ...settings,
        city: detected.city,
        country: detected.country,
        latitude: detected.latitude,
        longitude: detected.longitude,
        useDeviceLocation: true,
        widgetEnabled: true,
      };
      setSettings(updatedSettings);
      await saveSettings(updatedSettings);
      await syncPrayerCache();
      await refreshWidget();
      lastPersistedSettingsRef.current = serializeSettings({
        ...updatedSettings,
        city: updatedSettings.city.trim(),
        country: updatedSettings.country.trim(),
        widgetEnabled: true,
      });
      setSearchQuery(detected.city ? `${detected.city}, ${detected.country}` : '');
      setSuccessMessage('Location detected successfully.');
    } catch (error) {
      console.error(error);
      setPrayerPanelState('location_required');
      setErrorMessage('Could not detect location. Please select city manually.');
    } finally {
      setDetecting(false);
      setLocationSetupResolved(true);
    }
  };

  const onSelectCity = (city: string, country: string) => {
    setSettings(prev => ({
      ...prev,
      city,
      country,
      latitude: null,
      longitude: null,
      useDeviceLocation: false,
    }));
    setSearchQuery(`${city}, ${country}`);
  };

  const resolveCurrentCoordinates = async (): Promise<{
    latitude: number;
    longitude: number;
  }> => {
    if (settings.latitude !== null && settings.longitude !== null) {
      return {latitude: settings.latitude, longitude: settings.longitude};
    }

    if (settings.useDeviceLocation) {
      const granted = await requestLocationPermission();
      if (!granted) {
        throw new Error('Location permission denied');
      }

      const detected = await detectLocation();
      setSettings(prev => ({
        ...prev,
        city: detected.city,
        country: detected.country,
        latitude: detected.latitude,
        longitude: detected.longitude,
      }));

      return {latitude: detected.latitude, longitude: detected.longitude};
    }

    if (settings.city.trim().length > 0 && settings.country.trim().length > 0) {
      return resolveCoordinates(settings.city.trim(), settings.country.trim());
    }

    throw new Error('Location is not configured');
  };

  const onOpenQibla = async () => {
    setErrorMessage('');
    setSuccessMessage('');
    setQiblaLoading(true);

    try {
      const coords = await resolveCurrentCoordinates();
      const direction = await getQiblaDirection(coords.latitude, coords.longitude);
      setQiblaDirection(direction);
      setQiblaVisible(true);
    } catch (error) {
      console.error(error);
      setErrorMessage('Unable to get Qibla direction. Set location and try again.');
    } finally {
      setQiblaLoading(false);
    }
  };

  const onOpenAllPrayerTimings = async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const timings = await getPrayerTimesForDate(today);
      setPrayerTimes(timings);
      setAllPrayerTimesVisible(true);
    } catch {
      if (prayerTimes) {
        setAllPrayerTimesVisible(true);
      } else {
        setErrorMessage('Prayer timings are not available yet.');
      }
    }
  };

  const onToggleNotifications = async (enabled: boolean) => {
    if (!enabled) {
      updateField('notificationsEnabled', false);
      return;
    }

    const granted = await requestNotificationPermission();
    if (!granted) {
      setErrorMessage(
        'Please grant notifications access to application in your settings.',
      );
      updateField('notificationsEnabled', false);
      return;
    }

    setErrorMessage('');
    updateField('notificationsEnabled', true);
  };

  const qiblaArrowRotation =
    qiblaDirection === null ? 0 : (qiblaDirection - qiblaHeading + 360) % 360;
  const allPrayerRows = getAllPrayerRows(prayerTimes, new Date());

  if (loading) {
    return (
      <SafeAreaView style={styles.loaderContainer}>
        <StatusBar barStyle="dark-content" backgroundColor={C.canvas} />
        <ActivityIndicator size="large" color={C.primary} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <StatusBar barStyle="dark-content" backgroundColor={C.canvas} />
      <ScrollView
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.greeting}>ASSALAMU ALAIKUM</Text>
          <Text style={styles.title}>Prayer Countdown</Text>
          <TouchableOpacity
            style={styles.locationChip}
            activeOpacity={0.7}
            onPress={() => setLocationEditorVisible(true)}>
            <Text style={styles.locationChipDot}>◍</Text>
            <Text style={styles.locationChipText} numberOfLines={1}>
              {locationSummary}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.hero}>
          <View style={styles.heroBlobBlue} pointerEvents="none" />
          <View style={styles.heroBlobPink} pointerEvents="none" />
          {prayerPanelState === 'ready' ? (
            <>
              <View style={styles.heroChip}>
                <View style={styles.heroDot} />
                <Text style={styles.heroChipText}>{currentPrayerName} now</Text>
              </View>
              <Text style={styles.heroEyebrow}>
                NEXT · {nextPrayerName.toUpperCase()} IN
              </Text>
              <Text style={styles.heroCountdown}>{nextPrayerCountdown}</Text>
              <View style={styles.heroDatePill}>
                <Text style={styles.heroDateGlyph}>🌙</Text>
                <Text style={styles.heroDateText} numberOfLines={1}>
                  {dateFooterText}
                </Text>
              </View>
            </>
          ) : (
            <View style={styles.heroStatusWrap}>
              <Text style={styles.heroStatusText}>
                {prayerPanelState === 'loading'
                  ? 'Loading prayer times…'
                  : prayerPanelState === 'location_required'
                    ? 'Set your location to begin'
                    : 'Unable to load prayer times'}
              </Text>
              {prayerPanelState === 'location_required' && (
                <TouchableOpacity
                  style={styles.heroStatusButton}
                  activeOpacity={0.85}
                  onPress={() => setLocationEditorVisible(true)}>
                  <Text style={styles.heroStatusButtonText}>Set location</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>

        <View style={styles.quickRow}>
          <TouchableOpacity
            style={styles.quickCard}
            activeOpacity={0.85}
            onPress={onOpenAllPrayerTimings}>
            <IconBadge glyph="🕌" tint={C.mint} />
            <Text style={styles.quickTitle}>Prayer times</Text>
            <Text style={styles.quickSub}>View today</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.quickCard}
            activeOpacity={0.85}
            onPress={onOpenQibla}
            disabled={qiblaLoading}>
            <IconBadge glyph="🧭" tint={C.blueTint} />
            <Text style={styles.quickTitle}>Qibla</Text>
            <Text style={styles.quickSub}>
              {qiblaLoading ? 'Loading…' : 'Find direction'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.groupCard}>
          <TouchableOpacity
            style={styles.row}
            activeOpacity={0.6}
            onPress={() => setLocationEditorVisible(true)}>
            <IconBadge glyph="📍" tint={C.blueTint} />
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Location</Text>
              <Text style={styles.rowValue} numberOfLines={1}>
                {locationSummary}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>

          <View style={styles.divider} />

          <TouchableOpacity
            style={styles.row}
            activeOpacity={0.6}
            onPress={() => setWidgetHelpVisible(true)}>
            <IconBadge glyph="🏠" tint={C.amberTint} />
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Add widget</Text>
              <Text style={styles.rowValue}>Home-screen setup</Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>

          <View style={styles.divider} />

          <View style={styles.row}>
            <IconBadge glyph="📖" tint={C.mint} />
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>School of thought</Text>
            </View>
            <View style={styles.segment}>
              <TouchableOpacity
                style={[
                  styles.segmentItem,
                  settings.school === 1 && styles.segmentItemActive,
                ]}
                onPress={() => updateField('school', 1)}>
                <Text
                  style={[
                    styles.segmentText,
                    settings.school === 1 && styles.segmentTextActive,
                  ]}>
                  Hanafi
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.segmentItem,
                  settings.school === 0 && styles.segmentItemActive,
                ]}
                onPress={() => updateField('school', 0)}>
                <Text
                  style={[
                    styles.segmentText,
                    settings.school === 0 && styles.segmentTextActive,
                  ]}>
                  Shafi
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.row}>
            <IconBadge glyph="🔔" tint={C.mint} />
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Prayer alerts</Text>
              <Text style={styles.rowValue}>Notify when prayer starts</Text>
            </View>
            <Switch
              value={settings.notificationsEnabled}
              onValueChange={onToggleNotifications}
              trackColor={{false: C.trackOff, true: '#9AD9BE'}}
              thumbColor={settings.notificationsEnabled ? C.primary : '#FFFFFF'}
              ios_backgroundColor={C.trackOff}
            />
          </View>
        </View>

        {(errorMessage || successMessage) && (
          <View
            style={[
              styles.banner,
              errorMessage ? styles.bannerError : styles.bannerSuccess,
            ]}>
            <Text
              style={[
                styles.bannerText,
                errorMessage ? styles.bannerTextError : styles.bannerTextSuccess,
              ]}>
              {errorMessage || successMessage}
            </Text>
          </View>
        )}
      </ScrollView>

      <Modal
        transparent
        animationType="slide"
        visible={locationEditorVisible}
        onRequestClose={() => setLocationEditorVisible(false)}>
        <View style={styles.sheetOverlay}>
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>Edit location</Text>

            <TouchableOpacity
              style={styles.detectButton}
              activeOpacity={0.85}
              onPress={onDetectLocation}
              disabled={detecting}>
              <Text style={styles.detectGlyph}>◍</Text>
              <Text style={styles.detectButtonText}>
                {detecting ? 'Detecting…' : 'Auto-detect my location'}
              </Text>
            </TouchableOpacity>

            <Text style={styles.fieldLabel}>SEARCH CITY</Text>
            <TextInput
              style={styles.input}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Type a city name"
              placeholderTextColor={C.inkFaint}
            />

            {filteredCities.length > 0 && (
              <ScrollView
                style={styles.suggestionList}
                keyboardShouldPersistTaps="handled">
                {filteredCities.map(option => {
                  const key = `${option.city}-${option.country}`;
                  return (
                    <TouchableOpacity
                      key={key}
                      style={styles.suggestionItem}
                      onPress={() => onSelectCity(option.city, option.country)}>
                      <Text style={styles.suggestionDot}>◍</Text>
                      <Text style={styles.suggestionText}>
                        {option.city}, {option.country}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}

            <View style={styles.fieldRow}>
              <View style={styles.fieldHalf}>
                <Text style={styles.fieldLabel}>CITY</Text>
                <TextInput
                  style={styles.input}
                  value={settings.city}
                  onChangeText={value => {
                    updateField('city', value);
                    updateField('useDeviceLocation', false);
                    updateField('latitude', null);
                    updateField('longitude', null);
                  }}
                  placeholder="City"
                  placeholderTextColor={C.inkFaint}
                />
              </View>
              <View style={styles.fieldHalf}>
                <Text style={styles.fieldLabel}>COUNTRY</Text>
                <TextInput
                  style={styles.input}
                  value={settings.country}
                  onChangeText={value => {
                    updateField('country', value);
                    updateField('useDeviceLocation', false);
                    updateField('latitude', null);
                    updateField('longitude', null);
                  }}
                  placeholder="Country"
                  placeholderTextColor={C.inkFaint}
                />
              </View>
            </View>

            <TouchableOpacity
              style={styles.primaryButton}
              activeOpacity={0.85}
              onPress={() => setLocationEditorVisible(false)}>
              <Text style={styles.primaryButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={allPrayerTimesVisible}
        onRequestClose={() => setAllPrayerTimesVisible(false)}>
        <View style={styles.centerOverlay}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Today's prayers</Text>
            <View style={styles.timingList}>
              {allPrayerRows.map(row => (
                <View
                  key={row.name}
                  style={[
                    styles.timingRow,
                    row.isCurrent && styles.timingRowCurrent,
                  ]}>
                  <View style={styles.timingLeft}>
                    {row.isCurrent && <View style={styles.timingActiveDot} />}
                    <Text
                      style={[
                        styles.timingName,
                        row.isPassed && styles.timingNamePassed,
                        row.isCurrent && styles.timingNameCurrent,
                      ]}>
                      {row.name}
                    </Text>
                  </View>
                  <Text
                    style={[
                      styles.timingValue,
                      row.isPassed && styles.timingValuePassed,
                      row.isCurrent && styles.timingValueCurrent,
                    ]}>
                    {row.time}
                  </Text>
                </View>
              ))}
            </View>
            <TouchableOpacity
              style={styles.ghostButton}
              onPress={() => setAllPrayerTimesVisible(false)}>
              <Text style={styles.ghostButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={widgetHelpVisible}
        onRequestClose={() => setWidgetHelpVisible(false)}>
        <View style={styles.centerOverlay}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Add the widget</Text>
            {[
              'Touch and hold an empty spot on your home screen.',
              'Tap “Widgets”.',
              'Find “Prayer Countdown”.',
              'Drag it onto your home screen.',
            ].map((step, index) => (
              <View key={step} style={styles.stepRow}>
                <View style={styles.stepNum}>
                  <Text style={styles.stepNumText}>{index + 1}</Text>
                </View>
                <Text style={styles.stepText}>{step}</Text>
              </View>
            ))}
            <TouchableOpacity
              style={styles.ghostButton}
              onPress={() => setWidgetHelpVisible(false)}>
              <Text style={styles.ghostButtonText}>Got it</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={qiblaVisible}
        onRequestClose={() => setQiblaVisible(false)}>
        <View style={styles.centerOverlay}>
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>Qibla compass</Text>
            <Text style={styles.dialogSubtitle}>
              Hold your phone flat for the best accuracy.
            </Text>

            <View style={styles.compassOuter}>
              <View style={styles.compassCircle}>
                <View
                  style={[
                    styles.cardinalLayer,
                    {transform: [{rotate: `${-qiblaHeading}deg`}]},
                  ]}>
                  <Text style={[styles.directionMark, styles.markNorth]}>N</Text>
                  <Text style={[styles.directionMark, styles.markEast]}>E</Text>
                  <Text style={[styles.directionMark, styles.markSouth]}>S</Text>
                  <Text style={[styles.directionMark, styles.markWest]}>W</Text>
                </View>

                <View
                  style={[
                    styles.qiblaArrowContainer,
                    {transform: [{rotate: `${qiblaArrowRotation}deg`}]},
                  ]}>
                  <View style={styles.qiblaArrowStem} />
                  <Text style={styles.qiblaArrowHead}>▲</Text>
                </View>

                <View style={styles.compassCenterDot} />
              </View>
            </View>

            <View style={styles.qiblaStats}>
              <View style={styles.qiblaStat}>
                <Text style={styles.qiblaStatValue}>
                  {qiblaHeading.toFixed(0)}°
                </Text>
                <Text style={styles.qiblaStatLabel}>HEADING</Text>
              </View>
              <View style={styles.qiblaStatDivider} />
              <View style={styles.qiblaStat}>
                <Text style={styles.qiblaStatValue}>
                  {(qiblaDirection ?? 0).toFixed(0)}°
                </Text>
                <Text style={styles.qiblaStatLabel}>QIBLA</Text>
              </View>
            </View>

            <TouchableOpacity
              style={styles.ghostButton}
              onPress={() => setQiblaVisible(false)}>
              <Text style={styles.ghostButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function getPrayerSnapshot(times: PrayerTimes, now: Date): {
  currentPrayer: string;
  nextPrayer: string;
  countdown: string;
} {
  const fajr = dateAt(now, times.fajr);
  const hasSunrise = isValidHhmm(times.sunrise);
  const sunrise = hasSunrise ? dateAt(now, times.sunrise) : null;
  const dhuhr = dateAt(now, times.dhuhr);
  const asr = dateAt(now, times.asr);
  const maghrib = dateAt(now, times.maghrib);
  const isha = dateAt(now, times.isha);
  const nextDayFajr = new Date(fajr.getTime() + 24 * 60 * 60 * 1000);

  let currentPrayer = 'Isha';
  let nextPrayer = 'Fajr';
  let nextMoment = fajr;

  if (now < fajr) {
    currentPrayer = 'Isha';
    nextPrayer = 'Fajr';
    nextMoment = fajr;
  } else if (sunrise && now < sunrise) {
    currentPrayer = 'Fajr';
    nextPrayer = 'Sunrise';
    nextMoment = sunrise;
  } else if (now < dhuhr) {
    currentPrayer = sunrise ? 'Sunrise' : 'Fajr';
    nextPrayer = 'Dhuhr';
    nextMoment = dhuhr;
  } else if (now < asr) {
    currentPrayer = 'Dhuhr';
    nextPrayer = 'Asr';
    nextMoment = asr;
  } else if (now < maghrib) {
    currentPrayer = 'Asr';
    nextPrayer = 'Maghrib';
    nextMoment = maghrib;
  } else if (now < isha) {
    currentPrayer = 'Maghrib';
    nextPrayer = 'Isha';
    nextMoment = isha;
  } else {
    currentPrayer = 'Isha';
    nextPrayer = 'Fajr';
    nextMoment = nextDayFajr;
  }

  const diffSeconds = Math.max(
    0,
    Math.floor((nextMoment.getTime() - now.getTime()) / 1000),
  );

  return {
    currentPrayer,
    nextPrayer,
    countdown: formatDuration(diffSeconds),
  };
}

function dateAt(base: Date, hhmm: string): Date {
  if (!isValidHhmm(hhmm)) {
    return new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      0,
      0,
      0,
      0,
    );
  }
  const [h, m] = hhmm.split(':').map(part => parseInt(part, 10) || 0);
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    h,
    m,
    0,
    0,
  );
}

function isValidHhmm(value?: string): value is string {
  return typeof value === 'string' && value.includes(':');
}

type PrayerRow = {
  name: string;
  time: string;
  isPassed: boolean;
  isCurrent: boolean;
};

function getAllPrayerRows(times: PrayerTimes | null, now: Date): PrayerRow[] {
  const entries = [
    {name: 'Fajr', key: 'fajr'},
    {name: 'Sunrise', key: 'sunrise'},
    {name: 'Dhuhr', key: 'dhuhr'},
    {name: 'Asr', key: 'asr'},
    {name: 'Maghrib', key: 'maghrib'},
    {name: 'Isha', key: 'isha'},
  ] as const;

  if (!times) {
    return entries.map(entry => ({
      name: entry.name,
      time: '--:--',
      isPassed: false,
      isCurrent: false,
    }));
  }

  const starts = entries.map(entry => {
    const value = times[entry.key];
    return isValidHhmm(value) ? dateAt(now, value) : null;
  });

  const firstStart = starts[0];
  const lastValidIndex = (() => {
    for (let i = starts.length - 1; i >= 0; i -= 1) {
      if (starts[i]) {
        return i;
      }
    }
    return -1;
  })();

  let currentIndex = starts.findIndex((start, index) => {
    if (!start) {
      return false;
    }
    const next = starts[index + 1];
    if (!next) {
      return now >= start;
    }
    return now >= start && now < next;
  });

  // Between midnight and Fajr, keep previous day's Isha active.
  if (currentIndex < 0 && firstStart && now < firstStart && lastValidIndex >= 0) {
    currentIndex = lastValidIndex;
  }

  return entries.map((entry, index) => {
    const rawTime = times[entry.key];
    const time = isValidHhmm(rawTime) ? rawTime : '--:--';
    const isCurrent = index === currentIndex;
    const isPassed = currentIndex >= 0 ? index < currentIndex : false;
    return {
      name: entry.name,
      time,
      isPassed,
      isCurrent,
    };
  });
}

function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, totalSeconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(
    2,
    '0',
  )}:${String(seconds).padStart(2, '0')}`;
}

function hasConfiguredLocation(value: AppSettings): boolean {
  return (
    (value.latitude !== null && value.longitude !== null) ||
    (value.city.trim().length > 0 && value.country.trim().length > 0)
  );
}

function getDateIsoOffset(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function buildDateFooterText(today: PrayerTimes, tomorrow: PrayerTimes | null): string {
  const now = new Date();
  const maghrib = dateAt(now, today.maghrib);
  const hijri = now >= maghrib ? tomorrow?.hijri || today.hijri : today.hijri;
  const gregorian = today.gregorian || now.toLocaleDateString();
  return `${hijri || '--'}, ${gregorian}`;
}

function serializeSettings(value: AppSettings): string {
  return JSON.stringify({
    city: value.city.trim(),
    country: value.country.trim(),
    latitude: value.latitude,
    longitude: value.longitude,
    useDeviceLocation: value.useDeviceLocation,
    school: value.school,
    notificationsEnabled: value.notificationsEnabled,
    widgetEnabled: true,
  });
}

const styles = StyleSheet.create({
  safeArea: {flex: 1, backgroundColor: C.canvas},
  loaderContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: C.canvas,
  },
  container: {paddingHorizontal: 18, paddingTop: 6, paddingBottom: 36},

  header: {marginBottom: 16},
  greeting: {fontSize: 11, letterSpacing: 1.6, color: C.inkFaint, fontWeight: '700'},
  title: {
    fontSize: 27,
    fontWeight: '800',
    color: C.ink,
    marginTop: 3,
    letterSpacing: -0.3,
  },
  locationChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    backgroundColor: C.card,
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 13,
    marginTop: 12,
    shadowColor: '#14241D',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: {width: 0, height: 2},
    elevation: 1,
  },
  locationChipDot: {fontSize: 13, color: C.primaryBright},
  locationChipText: {fontSize: 13, color: '#3C4A43', fontWeight: '600', maxWidth: 230},

  hero: {
    borderRadius: 28,
    padding: 22,
    marginBottom: 14,
    minHeight: 190,
    justifyContent: 'center',
    backgroundColor: '#EDF0FB',
    overflow: 'hidden',
    shadowColor: '#5E6E96',
    shadowOpacity: 0.18,
    shadowRadius: 22,
    shadowOffset: {width: 0, height: 12},
    elevation: 4,
  },
  heroBlobBlue: {
    position: 'absolute',
    width: 300,
    height: 300,
    borderRadius: 150,
    backgroundColor: '#E3ECFF',
    top: -130,
    left: -80,
  },
  heroBlobPink: {
    position: 'absolute',
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: '#FBE9F2',
    bottom: -130,
    right: -70,
  },
  heroChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 7,
    backgroundColor: 'rgba(255,255,255,0.72)',
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11,
  },
  heroDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: C.primaryBright},
  heroChipText: {fontSize: 12.5, fontWeight: '700', color: '#2E5C49'},
  heroEyebrow: {
    fontSize: 11,
    letterSpacing: 1.6,
    fontWeight: '700',
    color: '#8C8FAE',
    marginTop: 16,
  },
  heroCountdown: {
    fontSize: 44,
    fontWeight: '800',
    color: C.mintInk,
    marginTop: 3,
    letterSpacing: 0.5,
    fontVariant: ['tabular-nums'],
  },
  heroDatePill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 7,
    backgroundColor: 'rgba(255,255,255,0.6)',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 12,
    marginTop: 14,
    maxWidth: '100%',
  },
  heroDateGlyph: {fontSize: 13},
  heroDateText: {fontSize: 12.5, color: '#5A5675', fontWeight: '600', flexShrink: 1},
  heroStatusWrap: {alignItems: 'flex-start'},
  heroStatusText: {fontSize: 17, color: '#4C5566', fontWeight: '700'},
  heroStatusButton: {
    marginTop: 14,
    backgroundColor: C.primary,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 18,
  },
  heroStatusButtonText: {color: '#FFFFFF', fontWeight: '700', fontSize: 14},

  quickRow: {flexDirection: 'row', gap: 11, marginBottom: 14},
  quickCard: {
    flex: 1,
    backgroundColor: C.card,
    borderRadius: 18,
    padding: 14,
    shadowColor: '#14241D',
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: {width: 0, height: 4},
    elevation: 2,
  },
  quickTitle: {fontSize: 14, fontWeight: '700', color: C.ink, marginTop: 10},
  quickSub: {fontSize: 12, color: C.inkFaint, marginTop: 1},

  iconBadge: {
    width: 36,
    height: 36,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBadgeGlyph: {fontSize: 17},

  groupCard: {
    backgroundColor: C.card,
    borderRadius: 20,
    paddingHorizontal: 14,
    marginBottom: 14,
    shadowColor: '#14241D',
    shadowOpacity: 0.05,
    shadowRadius: 12,
    shadowOffset: {width: 0, height: 4},
    elevation: 2,
  },
  row: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13},
  rowBody: {flex: 1},
  rowTitle: {fontSize: 14.5, fontWeight: '600', color: C.ink},
  rowValue: {fontSize: 12.5, color: C.inkFaint, marginTop: 1},
  chevron: {fontSize: 22, color: '#C2CCC6', marginTop: -2},
  divider: {height: 1, backgroundColor: C.line, marginLeft: 48},

  segment: {
    flexDirection: 'row',
    backgroundColor: '#F1F4F2',
    borderRadius: 999,
    padding: 3,
  },
  segmentItem: {paddingVertical: 6, paddingHorizontal: 13, borderRadius: 999},
  segmentItemActive: {backgroundColor: C.primary},
  segmentText: {fontSize: 12.5, fontWeight: '600', color: '#7C887F'},
  segmentTextActive: {color: '#FFFFFF', fontWeight: '700'},

  banner: {borderRadius: 14, padding: 13, marginTop: 2},
  bannerError: {backgroundColor: '#FBEBEA', borderWidth: 1, borderColor: '#F2C9C6'},
  bannerSuccess: {backgroundColor: '#E7F6EE', borderWidth: 1, borderColor: '#BFE6CF'},
  bannerText: {fontSize: 13, fontWeight: '500'},
  bannerTextError: {color: '#8E2A20'},
  bannerTextSuccess: {color: '#0B5A38'},

  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,25,20,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: C.canvas,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 26,
    maxHeight: '88%',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#CDD6D1',
    marginBottom: 14,
  },
  sheetTitle: {fontSize: 19, fontWeight: '800', color: C.ink, marginBottom: 14},
  detectButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: C.primary,
    borderRadius: 14,
    paddingVertical: 13,
  },
  detectGlyph: {color: '#FFFFFF', fontSize: 15},
  detectButtonText: {color: '#FFFFFF', fontWeight: '700', fontSize: 14.5},
  fieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: C.inkSoft,
    letterSpacing: 0.8,
    marginTop: 16,
    marginBottom: 7,
  },
  input: {
    backgroundColor: C.card,
    borderRadius: 13,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14.5,
    color: C.ink,
    borderWidth: 1,
    borderColor: '#E6EBE8',
  },
  suggestionList: {maxHeight: 168, marginTop: 8},
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: C.card,
    borderRadius: 12,
    paddingVertical: 11,
    paddingHorizontal: 13,
    marginBottom: 7,
    borderWidth: 1,
    borderColor: '#EEF2EF',
  },
  suggestionDot: {fontSize: 13, color: C.primaryBright},
  suggestionText: {fontSize: 13.5, color: '#33403A', fontWeight: '500'},
  fieldRow: {flexDirection: 'row', gap: 12},
  fieldHalf: {flex: 1},
  primaryButton: {
    backgroundColor: C.ink,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 20,
  },
  primaryButtonText: {color: '#FFFFFF', fontWeight: '700', fontSize: 15},

  centerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(15,25,20,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  dialog: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: C.card,
    borderRadius: 22,
    padding: 20,
  },
  dialogTitle: {fontSize: 19, fontWeight: '800', color: C.ink, marginBottom: 4},
  dialogSubtitle: {fontSize: 13, color: C.inkSoft, marginBottom: 16},
  timingList: {marginTop: 4, marginBottom: 6},
  timingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  timingRowCurrent: {backgroundColor: C.mint},
  timingLeft: {flexDirection: 'row', alignItems: 'center', gap: 9},
  timingActiveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: C.primaryBright,
  },
  timingName: {fontSize: 15, color: C.ink, fontWeight: '600'},
  timingNamePassed: {color: C.inkFaint, fontWeight: '500'},
  timingNameCurrent: {color: C.primary, fontWeight: '700'},
  timingValue: {
    fontSize: 15,
    color: C.inkSoft,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  timingValuePassed: {color: C.inkFaint, fontWeight: '500'},
  timingValueCurrent: {color: C.primary},
  ghostButton: {
    marginTop: 14,
    borderRadius: 13,
    paddingVertical: 13,
    alignItems: 'center',
    backgroundColor: '#EFF3F1',
  },
  ghostButtonText: {color: C.ink, fontWeight: '700', fontSize: 14.5},
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    marginBottom: 13,
  },
  stepNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: C.mint,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  stepNumText: {fontSize: 13, fontWeight: '800', color: C.primary},
  stepText: {flex: 1, fontSize: 14, color: '#3C4A43', lineHeight: 20},

  compassOuter: {
    width: 250,
    height: 250,
    alignSelf: 'center',
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 6,
  },
  compassCircle: {
    width: 240,
    height: 240,
    borderRadius: 120,
    borderWidth: 2,
    borderColor: '#E2EAE5',
    backgroundColor: '#F6FAF8',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  cardinalLayer: {position: 'absolute', width: 240, height: 240},
  directionMark: {
    position: 'absolute',
    fontWeight: '700',
    color: '#54635B',
    fontSize: 15,
  },
  markNorth: {top: 12, left: '50%', marginLeft: -5},
  markEast: {right: 12, top: '50%', marginTop: -9},
  markSouth: {bottom: 12, left: '50%', marginLeft: -4},
  markWest: {left: 12, top: '50%', marginTop: -9},
  qiblaArrowContainer: {
    position: 'absolute',
    width: 210,
    height: 210,
    justifyContent: 'flex-start',
    alignItems: 'center',
  },
  qiblaArrowStem: {
    width: 4,
    height: 82,
    backgroundColor: C.primary,
    borderRadius: 2,
    marginTop: 18,
  },
  qiblaArrowHead: {marginTop: -8, fontSize: 26, color: C.primary},
  compassCenterDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: C.primary,
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  qiblaStats: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    marginBottom: 2,
  },
  qiblaStat: {alignItems: 'center', paddingHorizontal: 24},
  qiblaStatValue: {
    fontSize: 20,
    fontWeight: '800',
    color: C.ink,
    fontVariant: ['tabular-nums'],
  },
  qiblaStatLabel: {fontSize: 11, color: C.inkFaint, marginTop: 2, letterSpacing: 0.8},
  qiblaStatDivider: {width: 1, height: 34, backgroundColor: C.line},
});

export default App;
