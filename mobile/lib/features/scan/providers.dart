import 'dart:math';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../receipts/models.dart';
import '../receipts/receipts_api.dart';
import 'media.dart';

final receiptsApiProvider = Provider<ReceiptsApi>(
  (ref) => ReceiptsApi(ref.watch(dioProvider)),
);

final mediaPickerProvider = Provider<MediaPicker>((_) => SystemMediaPicker());

final mediaNormalizerProvider = Provider<MediaNormalizer>(
  (_) => const NativeMediaNormalizer(),
);

final tempFilesProvider = Provider<TempFiles>((_) => const SystemTempFiles());

/// Pauza dintre două interogări ale unui document aflat în procesare: crește de la 2 s la 8 s.
/// Înlocuibilă în teste.
final pollDelayProvider = Provider<Duration Function(int attempt)>(
  (_) =>
      (attempt) => Duration(seconds: min(2 + attempt, 8)),
);

/// „X din Y documente azi”, de la server.
final aiUsageProvider = FutureProvider.autoDispose<AiUsage>(
  (ref) => ref.watch(receiptsApiProvider).aiUsage(),
);

/// Starea unui document, reinterogată cât timp se mișcă (în coadă, în procesare). Se oprește la o
/// stare finală sau de așteptare (de verificat, salvat, eșuat, refuzat, fără acord AI) și când
/// ecranul se închide (`autoDispose`).
final documentProvider = StreamProvider.autoDispose
    .family<DocumentInfo, String>((ref, id) async* {
      final api = ref.watch(receiptsApiProvider);
      final delay = ref.watch(pollDelayProvider);
      var attempt = 0;
      while (true) {
        final doc = await api.document(id);
        yield doc;
        if (!doc.status.inFlight) return;
        await Future<void>.delayed(delay(attempt++));
      }
    });
