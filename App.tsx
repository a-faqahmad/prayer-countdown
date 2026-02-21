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
  const [prayerPanelState, setPrayerPanelState] =
    useState<PrayerPanelState>('loading');
  const autoLocationCheckedRef = useRef(false);
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
      return;
    }

    if (hasConfiguredLocation(settings)) {
      autoLocationCheckedRef.current = true;
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
      }
    };

    autoDetect();
  }, [loading, settings]);

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
      setErrorMessage('Notification permission denied. Notifications remain off.');
      updateField('notificationsEnabled', false);
      return;
    }

    setErrorMessage('');
    updateField('notificationsEnabled', true);
  };

  const qiblaArrowRotation =
    qiblaDirection === null ? 0 : (qiblaDirection - qiblaHeading + 360) % 360;

  if (loading) {
    return (
      <SafeAreaView style={styles.loaderContainer}>
        <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />
        <ActivityIndicator size="large" color="#0D6E4C" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor="#FFFFFF" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Prayer Countdown</Text>

        <View style={styles.livePrayerCard}>
          <View style={styles.livePrayerGradientPink} />
          <View style={styles.livePrayerGradientBlend} />
          <View style={styles.livePrayerGradientBlue} />
          {prayerPanelState === 'ready' ? (
            <>
              <Text style={styles.currentPrayerText}>{currentPrayerName}</Text>
              <Text style={styles.nextPrayerText}>Next Prayer: {nextPrayerName}</Text>
              <Text style={styles.countdownText}>{nextPrayerCountdown}</Text>
              <Text style={styles.dateFooterText}>{dateFooterText}</Text>
            </>
          ) : (
            <Text style={styles.panelStatusText}>
              {prayerPanelState === 'loading'
                ? 'loading...'
                : prayerPanelState === 'location_required'
                  ? 'location required'
                  : 'unable to load'}
            </Text>
          )}
        </View>
        <TouchableOpacity onPress={onOpenAllPrayerTimings}>
          <Text style={styles.allTimingsLink}>All prayer timings</Text>
        </TouchableOpacity>

        <View style={styles.cardSoft}>
          <Text style={styles.sectionTitle}>Qibla Direction</Text>
          <TouchableOpacity
            style={styles.qiblaButton}
            onPress={onOpenQibla}
            disabled={qiblaLoading}>
            <Text style={styles.qiblaButtonText}>
              {qiblaLoading ? 'Loading...' : 'Open Qibla Compass'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <View>
              <Text style={styles.sectionTitle}>Location</Text>
              <Text style={styles.locationText}>{locationSummary}</Text>
            </View>
            <TouchableOpacity
              style={styles.editIconButton}
              onPress={() => setLocationEditorVisible(true)}>
              <Text style={styles.editIcon}>✎</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <View>
              <Text style={styles.sectionTitle}>Add Widget</Text>
              <Text style={styles.locationText}>How to place it on home screen</Text>
            </View>
            <TouchableOpacity
              style={styles.helpIconButton}
              onPress={() => setWidgetHelpVisible(true)}>
              <Text style={styles.helpIcon}>?</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>School of Thought</Text>
          <View style={styles.pillRow}>
            <TouchableOpacity
              style={[
                styles.choicePill,
                settings.school === 1 && styles.choicePillSelected,
              ]}
              onPress={() => updateField('school', 1)}>
              <Text
                style={[
                  styles.choicePillText,
                  settings.school === 1 && styles.choicePillTextSelected,
                ]}>
                Hanafi
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.choicePill,
                settings.school === 0 && styles.choicePillSelected,
              ]}
              onPress={() => updateField('school', 0)}>
              <Text
                style={[
                  styles.choicePillText,
                  settings.school === 0 && styles.choicePillTextSelected,
                ]}>
                Shafi
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Notifications</Text>
          <View style={styles.rowBetween}>
            <Text style={styles.label}>Notify when prayer starts</Text>
            <Switch
              value={settings.notificationsEnabled}
              onValueChange={onToggleNotifications}
              trackColor={{false: '#D8D8D8', true: '#BFE3D5'}}
              thumbColor={settings.notificationsEnabled ? '#0D6E4C' : '#F3F3F3'}
            />
          </View>
        </View>

        {(errorMessage || successMessage) && (
          <View
            style={[
              styles.messageBox,
              errorMessage ? styles.errorBox : styles.successBox,
            ]}>
            <Text style={styles.messageText}>{errorMessage || successMessage}</Text>
          </View>
        )}

      </ScrollView>

      <Modal
        transparent
        animationType="slide"
        visible={locationEditorVisible}
        onRequestClose={() => setLocationEditorVisible(false)}>
        <View style={styles.bottomSheetOverlay}>
          <View style={styles.bottomSheet}>
            <View style={styles.sheetHandle} />
            <Text style={styles.bottomSheetTitle}>Edit Location</Text>

            <TouchableOpacity
              style={styles.primaryButton}
              onPress={onDetectLocation}
              disabled={detecting}>
              <Text style={styles.primaryButtonText}>
                {detecting ? 'Detecting...' : 'Auto detect location'}
              </Text>
            </TouchableOpacity>

            <TextInput
              style={styles.input}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Search city"
              placeholderTextColor="#909090"
            />

            <ScrollView style={styles.suggestionList}>
              {filteredCities.map(option => {
                const key = `${option.city}-${option.country}`;
                return (
                  <TouchableOpacity
                    key={key}
                    style={styles.suggestionItem}
                    onPress={() => onSelectCity(option.city, option.country)}>
                    <Text style={styles.suggestionText}>
                      {option.city}, {option.country}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

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
              placeholderTextColor="#909090"
            />
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
              placeholderTextColor="#909090"
            />

            <TouchableOpacity
              style={styles.sheetDoneButton}
              onPress={() => setLocationEditorVisible(false)}>
              <Text style={styles.sheetDoneButtonText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={allPrayerTimesVisible}
        onRequestClose={() => setAllPrayerTimesVisible(false)}>
        <View style={styles.helpOverlay}>
          <View style={styles.timingsCard}>
            <Text style={styles.helpTitle}>All Prayer Timings</Text>
            <View style={styles.timingRow}>
              <Text style={styles.timingName}>Fajr</Text>
              <Text style={styles.timingValue}>{prayerTimes?.fajr ?? '--:--'}</Text>
            </View>
            <View style={styles.timingRow}>
              <Text style={styles.timingName}>Dhuhr</Text>
              <Text style={styles.timingValue}>{prayerTimes?.dhuhr ?? '--:--'}</Text>
            </View>
            <View style={styles.timingRow}>
              <Text style={styles.timingName}>Asr</Text>
              <Text style={styles.timingValue}>{prayerTimes?.asr ?? '--:--'}</Text>
            </View>
            <View style={styles.timingRow}>
              <Text style={styles.timingName}>Maghrib</Text>
              <Text style={styles.timingValue}>{prayerTimes?.maghrib ?? '--:--'}</Text>
            </View>
            <View style={styles.timingRow}>
              <Text style={styles.timingName}>Isha</Text>
              <Text style={styles.timingValue}>{prayerTimes?.isha ?? '--:--'}</Text>
            </View>
            <TouchableOpacity
              style={styles.helpCloseButton}
              onPress={() => setAllPrayerTimesVisible(false)}>
              <Text style={styles.helpCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        animationType="fade"
        visible={widgetHelpVisible}
        onRequestClose={() => setWidgetHelpVisible(false)}>
        <View style={styles.helpOverlay}>
          <View style={styles.helpCard}>
            <Text style={styles.helpTitle}>How to Add Widget</Text>
            <Text style={styles.helpStep}>1. Press and hold on your home screen.</Text>
            <Text style={styles.helpStep}>2. Tap Widgets.</Text>
            <Text style={styles.helpStep}>3. Find Prayer Countdown.</Text>
            <Text style={styles.helpStep}>4. Tap and place the widget.</Text>
            <TouchableOpacity
              style={styles.helpCloseButton}
              onPress={() => setWidgetHelpVisible(false)}>
              <Text style={styles.helpCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        transparent
        animationType="slide"
        visible={qiblaVisible}
        onRequestClose={() => setQiblaVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Qibla Compass</Text>
            <Text style={styles.modalSubtitle}>Keep phone flat for better accuracy.</Text>

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

            <Text style={styles.qiblaInfoText}>Heading: {qiblaHeading.toFixed(1)}°</Text>
            <Text style={styles.qiblaInfoText}>
              Qibla: {(qiblaDirection ?? 0).toFixed(1)}° from North
            </Text>

            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => setQiblaVisible(false)}>
              <Text style={styles.closeButtonText}>Close</Text>
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
  } else if (now < dhuhr) {
    currentPrayer = 'Fajr';
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

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
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
  safeArea: {flex: 1, backgroundColor: '#FFFFFF'},
  loaderContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
  },
  container: {padding: 18, paddingBottom: 34},
  title: {fontSize: 30, fontWeight: '700', color: '#121212', marginBottom: 18},
  livePrayerCard: {
    backgroundColor: '#FAF5FC',
    borderRadius: 18,
    paddingVertical: 18,
    paddingHorizontal: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#E6DFF0',
    alignItems: 'center',
    overflow: 'hidden',
    position: 'relative',
  },
  livePrayerGradientPink: {
    position: 'absolute',
    width: 320,
    height: 190,
    borderRadius: 160,
    backgroundColor: '#FFEAF4',
    top: -72,
    left: -58,
    opacity: 0.8,
  },
  livePrayerGradientBlend: {
    position: 'absolute',
    width: 300,
    height: 180,
    borderRadius: 150,
    backgroundColor: '#FDF1F8',
    top: -18,
    right: -15,
    opacity: 0.82,
  },
  livePrayerGradientBlue: {
    position: 'absolute',
    width: 320,
    height: 200,
    borderRadius: 160,
    backgroundColor: '#EAF2FF',
    bottom: -80,
    right: -64,
    opacity: 0.82,
  },
  currentPrayerText: {
    fontSize: 34,
    fontWeight: '700',
    color: '#111111',
    textAlign: 'center',
  },
  nextPrayerText: {
    marginTop: 2,
    fontSize: 16,
    color: '#5A5A5A',
    textAlign: 'center',
  },
  countdownText: {
    marginTop: 6,
    fontSize: 28,
    fontWeight: '700',
    color: '#0D6E4C',
    textAlign: 'center',
  },
  dateFooterText: {
    marginTop: 8,
    fontSize: 13,
    color: '#555B6A',
    fontWeight: '500',
    textAlign: 'center',
  },
  panelStatusText: {
    fontSize: 12,
    fontStyle: 'italic',
    color: '#7B7B7B',
    textAlign: 'center',
    paddingVertical: 8,
  },
  allTimingsLink: {
    color: '#1E5BD8',
    textDecorationLine: 'underline',
    fontSize: 14,
    marginBottom: 12,
    textAlign: 'center',
    fontWeight: '600',
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 15,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#ECECEC',
  },
  cardSoft: {
    backgroundColor: '#F7FAFF',
    borderRadius: 16,
    padding: 15,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#DCE8FF',
  },
  sectionTitle: {fontSize: 16, fontWeight: '700', color: '#151515', marginBottom: 8},
  rowBetween: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  label: {fontSize: 14, color: '#2D2D2D', flex: 1, marginRight: 10},
  locationText: {fontSize: 14, color: '#5A5A5A', maxWidth: 250},
  editIconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: '#DADADA',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F9F9F9',
  },
  editIcon: {fontSize: 17, color: '#303030'},
  helpIconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: '#D7E5FF',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#EEF4FF',
  },
  helpIcon: {fontSize: 20, fontWeight: '700', color: '#0E4CA2'},
  qiblaButton: {
    backgroundColor: '#0E4CA2',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
  },
  qiblaButtonText: {color: '#FFFFFF', fontSize: 15, fontWeight: '700'},
  pillRow: {flexDirection: 'row'},
  choicePill: {
    borderWidth: 1,
    borderColor: '#D7D7D7',
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginRight: 8,
  },
  choicePillSelected: {borderColor: '#0D6E4C', backgroundColor: '#EAF7F2'},
  choicePillText: {fontSize: 13, color: '#424242', fontWeight: '600'},
  choicePillTextSelected: {color: '#0D6E4C'},
  messageBox: {borderRadius: 12, padding: 11, marginTop: 4, marginBottom: 12},
  errorBox: {backgroundColor: '#FDEBEC', borderWidth: 1, borderColor: '#F3B9BD'},
  successBox: {backgroundColor: '#E7F7EE', borderWidth: 1, borderColor: '#B8E6CA'},
  messageText: {fontSize: 13, color: '#333333'},
  bottomSheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'flex-end',
  },
  bottomSheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingBottom: 22,
    paddingTop: 10,
    maxHeight: '85%',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 48,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#DDDDDD',
    marginBottom: 10,
  },
  bottomSheetTitle: {fontSize: 18, fontWeight: '700', color: '#181818', marginBottom: 10},
  primaryButton: {
    backgroundColor: '#0D6E4C',
    borderRadius: 11,
    paddingVertical: 11,
    paddingHorizontal: 12,
    alignItems: 'center',
    marginBottom: 9,
  },
  primaryButtonText: {color: '#FFF', fontWeight: '600', fontSize: 14},
  input: {
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderRadius: 11,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1A1A1A',
    marginTop: 8,
    backgroundColor: '#FFFFFF',
  },
  suggestionList: {maxHeight: 160, marginTop: 6},
  suggestionItem: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#EFEFEF',
    paddingVertical: 9,
    paddingHorizontal: 12,
    marginTop: 6,
    backgroundColor: '#FAFAFA',
  },
  suggestionText: {fontSize: 13, color: '#333333'},
  sheetDoneButton: {
    marginTop: 14,
    backgroundColor: '#151515',
    borderRadius: 11,
    paddingVertical: 12,
    alignItems: 'center',
  },
  sheetDoneButtonText: {color: '#FFFFFF', fontWeight: '700', fontSize: 14},
  helpOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.42)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 22,
  },
  helpCard: {
    width: '100%',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: '#E7E7E7',
    backgroundColor: '#FFFFFF',
  },
  timingsCard: {
    width: '100%',
    borderRadius: 16,
    padding: 18,
    borderWidth: 1,
    borderColor: '#E7E7E7',
    backgroundColor: '#FFFFFF',
  },
  helpTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111111',
    marginBottom: 10,
  },
  helpStep: {
    fontSize: 14,
    color: '#444444',
    marginBottom: 6,
  },
  timingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F0F0',
  },
  timingName: {
    fontSize: 15,
    color: '#222222',
    fontWeight: '600',
  },
  timingValue: {
    fontSize: 15,
    color: '#0D6E4C',
    fontWeight: '700',
  },
  helpCloseButton: {
    marginTop: 10,
    borderRadius: 10,
    backgroundColor: '#111111',
    paddingVertical: 10,
    alignItems: 'center',
  },
  helpCloseText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    padding: 18,
    alignItems: 'center',
  },
  modalTitle: {fontSize: 22, fontWeight: '700', color: '#1A1A1A'},
  modalSubtitle: {marginTop: 4, marginBottom: 14, fontSize: 13, color: '#5B5B5B'},
  compassOuter: {width: 260, height: 260, justifyContent: 'center', alignItems: 'center'},
  compassCircle: {
    width: 250,
    height: 250,
    borderRadius: 125,
    borderWidth: 4,
    borderColor: '#D7E3DA',
    backgroundColor: '#F7FAF8',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  cardinalLayer: {
    position: 'absolute',
    width: 250,
    height: 250,
  },
  directionMark: {
    position: 'absolute',
    fontWeight: '700',
    color: '#2E2E2E',
    fontSize: 17,
  },
  markNorth: {top: 12},
  markEast: {right: 14},
  markSouth: {bottom: 12},
  markWest: {left: 14},
  qiblaArrowContainer: {
    position: 'absolute',
    width: 220,
    height: 220,
    justifyContent: 'flex-start',
    alignItems: 'center',
  },
  qiblaArrowStem: {
    width: 4,
    height: 88,
    backgroundColor: '#0B3D91',
    borderRadius: 2,
    marginTop: 20,
  },
  qiblaArrowHead: {marginTop: -7, fontSize: 28, color: '#0B3D91'},
  compassCenterDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#0D6E4C',
  },
  qiblaInfoText: {
    marginTop: 4,
    fontSize: 14,
    color: '#2D2D2D',
    fontWeight: '500',
  },
  closeButton: {
    marginTop: 14,
    backgroundColor: '#1B1B1B',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 22,
  },
  closeButtonText: {color: '#FFFFFF', fontSize: 14, fontWeight: '700'},
});

export default App;
