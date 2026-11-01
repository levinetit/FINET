import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_error.dart';
import '../../core/providers.dart';
import '../receipts/models.dart';
import '../receipts/receipts_api.dart';
import '../usage/usage_tracker.dart';
import 'media.dart';
import 'providers.dart';

/// Cel mult 4 poze pe un bon (limita serverului pentru `POST /documents`).
const int maxShots = 4;

class ScanState {
  const ScanState({
    this.items = const [],
    this.longReceipt = false,
    this.uploading = false,
    this.message,
    this.error,
    this.result,
  });

  final List<PickedMedia> items;
  final bool longReceipt;
  final bool uploading;

  /// Mesaj de validare locală (de exemplu „Bonul lung cere 2–4 poze”).
  final String? message;
  final ApiError? error;

  /// Rezultatul ultimei încărcări reușite.
  final UploadResult? result;

  bool get hasPdf => items.any((m) => m.kind == MediaKind.pdf);

  ScanState copyWith({
    List<PickedMedia>? items,
    bool? longReceipt,
    bool? uploading,
    String? Function()? message,
    ApiError? Function()? error,
    UploadResult? Function()? result,
  }) => ScanState(
    items: items ?? this.items,
    longReceipt: longReceipt ?? this.longReceipt,
    uploading: uploading ?? this.uploading,
    message: message != null ? message() : this.message,
    error: error != null ? error() : this.error,
    result: result != null ? result() : this.result,
  );
}

/// Pregătirea și încărcarea unui bon. Telefonul doar fotografiază, pregătește și încarcă: citirea
/// o face serverul.
class ScanController extends Notifier<ScanState> {
  /// Octeții pregătiți, după calea sursă. La o reîncercare după o eroare se trimit aceiași octeți:
  /// serverul recunoaște duplicatele după SHA-256, iar o recodare ar crea un duplicat real.
  final Map<String, UploadFile> _prepared = {};

  @override
  ScanState build() => const ScanState();

  void _started() {
    if (state.items.isEmpty) {
      ref.read(usageTrackerProvider).track(UsageEvents.receiptScanStarted);
    }
  }

  Future<void> addFromCamera() async {
    if (state.items.length >= maxShots) {
      return _full();
    }
    final shot = await ref.read(mediaPickerProvider).takePhoto();
    if (shot == null) return;
    _add([shot]);
  }

  Future<void> addFromGallery() async {
    final room = maxShots - state.items.length;
    if (room <= 0) return _full();
    final shots = await ref.read(mediaPickerProvider).pickImages(limit: room);
    _add(shots);
  }

  Future<void> addPdf() async {
    final file = await ref
        .read(mediaPickerProvider)
        .pickDocument(extensions: const ['pdf']);
    if (file == null) return;
    // Un PDF se încarcă singur.
    _discardAll();
    _started();
    state = ScanState(items: [file], longReceipt: false);
  }

  void _full() {
    state = state.copyWith(message: () => 'Cel mult $maxShots poze pe un bon.');
  }

  /// Adaugă poze; fișierele de alt tip sau peste limită se resping cu un mesaj.
  void _add(List<PickedMedia> shots) {
    if (shots.isEmpty) return;
    final images = [
      for (final s in shots)
        if (s.kind == MediaKind.image) s,
    ];
    final rejected = shots.length - images.length;
    _started();
    final base = state.hasPdf ? <PickedMedia>[] : state.items;
    final merged = [...base, ...images];
    final kept = merged.take(maxShots).toList();
    final dropped = merged.length - kept.length;
    state = state.copyWith(
      items: kept,
      message: () => rejected > 0
          ? 'Doar pozele (JPEG, PNG, WebP, HEIC) se pot adăuga aici.'
          : dropped > 0
          ? 'Cel mult $maxShots poze pe un bon.'
          : null,
      error: () => null,
    );
  }

  void remove(int index) {
    final items = [...state.items];
    final removed = items.removeAt(index);
    _prepared.remove(removed.path);
    state = state.copyWith(items: items, message: () => null);
    ref.read(tempFilesProvider).delete([removed.path]);
  }

  void reorder(int oldIndex, int newIndex) {
    final items = [...state.items];
    final target = newIndex > oldIndex ? newIndex - 1 : newIndex;
    items.insert(target, items.removeAt(oldIndex));
    state = state.copyWith(items: items);
  }

  void setLongReceipt(bool value) {
    state = state.copyWith(longReceipt: value, message: () => null);
  }

  void _discardAll() {
    final paths = [for (final m in state.items) m.path];
    _prepared.clear();
    ref.read(tempFilesProvider).delete(paths);
  }

  /// Renunță la poze (și le șterge din memoria temporară).
  void cancel() {
    _discardAll();
    state = const ScanState();
  }

  /// Golește rezultatul ultimei încărcări, după ce utilizatorul l-a văzut.
  void dismissResult() {
    if (state.result == null) return;
    state = state.copyWith(result: () => null);
  }

  Future<void> submit() async {
    if (state.uploading || state.items.isEmpty) return;
    if (state.longReceipt && state.items.length < 2) {
      state = state.copyWith(
        message: () => 'Bonul lung cere 2–4 poze, în ordinea de sus în jos.',
      );
      return;
    }
    state = state.copyWith(
      uploading: true,
      message: () => null,
      error: () => null,
    );
    try {
      final normalizer = ref.read(mediaNormalizerProvider);
      final files = <UploadFile>[];
      for (final item in state.items) {
        files.add(_prepared[item.path] ??= await normalizer.normalize(item));
      }
      final result = await ref
          .read(receiptsApiProvider)
          .upload(files, longReceipt: state.longReceipt);
      ref.read(usageTrackerProvider).track(UsageEvents.receiptUploaded);
      // Serverul a primit fișierele: copiile temporare nu mai trebuie.
      final paths = [for (final m in state.items) m.path];
      _prepared.clear();
      await ref.read(tempFilesProvider).delete(paths);
      state = ScanState(result: result);
    } on ApiError catch (e) {
      ref.read(usageTrackerProvider).error(e);
      state = state.copyWith(uploading: false, error: () => e);
    } on FormatException catch (e) {
      state = state.copyWith(uploading: false, message: () => e.message);
    }
  }
}

final scanControllerProvider = NotifierProvider<ScanController, ScanState>(
  ScanController.new,
);
