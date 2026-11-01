import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_error.dart';
import '../../core/platform/url_opener.dart';
import '../../core/providers.dart';
import '../../core/storage/key_value_store.dart';
import '../finance/models.dart';
import '../lock/app_lock.dart';
import '../usage/usage_tracker.dart';
import 'update_api.dart';
import 'update_info.dart';

class UpdateState {
  const UpdateState({this.info, this.dismissedCode});

  /// Ultima versiune cunoscută (din server sau din cache); `null` = niciuna.
  final UpdateInfo? info;

  /// Versiunea pe care utilizatorul a ascuns-o în această sesiune.
  final int? dismissedCode;

  UpdateState copyWith({UpdateInfo? info, int? dismissedCode}) => UpdateState(
    info: info ?? this.info,
    dismissedCode: dismissedCode ?? this.dismissedCode,
  );
}

/// Verifică actualizările: cel mult o dată pe zi (rezultatul se păstrează în stocare), la pornire
/// și după autentificare. Versiunea instalată sub `minSupportedVersionCode` blochează aplicația
/// (ecran de actualizare, fără cereri financiare).
/// Rezultatul păstrat la ultima verificare, citit la pornire (înainte de primul ecran), ca o
/// versiune respinsă de server să nu apuce să trimită cereri financiare.
final initialUpdateProvider = Provider<UpdateInfo?>((_) => null);

Future<UpdateInfo?> loadCachedUpdate(KeyValueStore store) async {
  try {
    final raw = await store.read(StoreKeys.updateCache);
    return raw == null ? null : UpdateInfo.fromJson(Json.map(jsonDecode(raw)));
  } on Object {
    return null;
  }
}

class UpdateController extends Notifier<UpdateState> {
  static const checkEvery = Duration(days: 1);

  /// Evită a doua verificare cât prima e în curs.
  bool _checking = false;
  bool _shownReported = false;

  int get _installed => ref.read(clientInfoProvider).versionCode;

  @override
  UpdateState build() => UpdateState(info: ref.read(initialUpdateProvider));

  bool get updateAvailable {
    final i = state.info;
    return i != null && i.versionCode > _installed;
  }

  /// Versiunea instalată nu mai e acceptată de server.
  bool get updateRequired {
    final i = state.info;
    return i != null && _installed < i.minSupportedVersionCode;
  }

  bool get bannerVisible =>
      updateAvailable && state.dismissedCode != state.info!.versionCode;

  /// Citește rezultatul păstrat (dacă există) și, dacă a trecut o zi, întreabă serverul.
  Future<void> check() async {
    if (_checking) return;
    _checking = true;
    try {
      final store = ref.read(keyValueStoreProvider);
      final cached = await store.read(StoreKeys.updateCache);
      if (cached != null) {
        try {
          state = state.copyWith(
            info: UpdateInfo.fromJson(Json.map(jsonDecode(cached))),
          );
          _reportShown();
        } on Object {
          // Cache stricat: se ignoră și se întreabă serverul.
        }
      }
      final at = int.tryParse(
        await store.read(StoreKeys.updateCheckedAt) ?? '',
      );
      final now = ref.read(clockProvider)();
      if (at != null &&
          cached != null &&
          now.difference(DateTime.fromMillisecondsSinceEpoch(at)) <
              checkEvery) {
        return;
      }
      try {
        final info = await ref.read(updateApiProvider).latest();
        if (info != null) {
          state = state.copyWith(info: info);
          await store.write(StoreKeys.updateCache, jsonEncode(info.toJson()));
          _reportShown();
        }
        await store.write(
          StoreKeys.updateCheckedAt,
          '${now.millisecondsSinceEpoch}',
        );
      } on ApiError {
        // Fără rețea sau server: se încearcă la următoarea pornire. Nu blochează nimic.
      }
    } finally {
      _checking = false;
    }
  }

  void _reportShown() {
    if (_shownReported || !bannerVisible) return;
    _shownReported = true;
    ref.read(usageTrackerProvider).track(UsageEvents.updatePromptShown);
  }

  void dismiss() {
    final i = state.info;
    if (i != null) state = state.copyWith(dismissedCode: i.versionCode);
  }

  /// Deschide linkul de descărcare. Aplicația nu instalează nimic singură.
  Future<bool> openDownload() async {
    final i = state.info;
    if (i == null) return false;
    ref.read(usageTrackerProvider).track(UsageEvents.updateStarted);
    return ref.read(urlOpenerProvider)(i.url);
  }
}

final updateControllerProvider =
    NotifierProvider<UpdateController, UpdateState>(UpdateController.new);
