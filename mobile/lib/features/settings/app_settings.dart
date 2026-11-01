import '../../core/storage/key_value_store.dart';

/// Setările locale ale aplicației (nu sunt date financiare). Se păstrează în stocarea
/// securizată, ca să nu existe un al doilea loc de stocare.
class AppSettings {
  const AppSettings({
    required this.introSeen,
    required this.usageStats,
    required this.appLock,
  });

  /// Ecranul de informare de la prima pornire a fost văzut.
  final bool introSeen;

  /// Trimite statistici de utilizare (evenimente). Antetul cu versiunea se trimite oricum.
  final bool usageStats;

  /// Blocare cu amprentă / PIN la deschidere și după ce aplicația stă în fundal.
  final bool appLock;

  AppSettings copyWith({bool? introSeen, bool? usageStats, bool? appLock}) =>
      AppSettings(
        introSeen: introSeen ?? this.introSeen,
        usageStats: usageStats ?? this.usageStats,
        appLock: appLock ?? this.appLock,
      );

  static Future<AppSettings> load(
    KeyValueStore store, {
    required bool usageStatsDefault,
  }) async {
    final intro = await store.read(StoreKeys.introSeen);
    final stats = await store.read(StoreKeys.usageStats);
    final lock = await store.read(StoreKeys.appLock);
    return AppSettings(
      introSeen: intro == '1',
      usageStats: stats == null ? usageStatsDefault : stats == '1',
      appLock: lock == '1',
    );
  }
}
