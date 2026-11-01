import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../../core/storage/key_value_store.dart';
import '../auth/session.dart';
import 'app_settings.dart';

/// Valorile inițiale, citite în `main()` înainte de `runApp` (suprascris acolo și în teste).
final initialSettingsProvider = Provider<AppSettings>(
  (ref) => throw UnimplementedError('initialSettingsProvider'),
);

final settingsProvider = NotifierProvider<SettingsController, AppSettings>(
  SettingsController.new,
);

class SettingsController extends Notifier<AppSettings> {
  @override
  AppSettings build() => ref.watch(initialSettingsProvider);

  Future<void> _write(String key, {required bool value}) =>
      ref.read(keyValueStoreProvider).write(key, value ? '1' : '0');

  /// Ecranul de informare a fost citit; `usageStats` e alegerea făcută acolo.
  Future<void> completeIntro({required bool usageStats}) async {
    state = state.copyWith(introSeen: true, usageStats: usageStats);
    ref.read(usageTrackerProvider).enabled = usageStats;
    await _write(StoreKeys.introSeen, value: true);
    await _write(StoreKeys.usageStats, value: usageStats);
  }

  /// Comutatorul „Trimite statistici de utilizare”: pornit/oprit local, apoi aliniat și pe server
  /// (consimțământul `usageStats`), dacă există o sesiune. Oprirea șterge coada locală.
  Future<void> setUsageStats({required bool enabled}) async {
    state = state.copyWith(usageStats: enabled);
    final tracker = ref.read(usageTrackerProvider)..enabled = enabled;
    if (!enabled) tracker.clear();
    await _write(StoreKeys.usageStats, value: enabled);
    await ref.read(sessionProvider.notifier).syncUsageConsent();
  }

  Future<void> setAppLock({required bool enabled}) async {
    state = state.copyWith(appLock: enabled);
    await _write(StoreKeys.appLock, value: enabled);
  }
}
