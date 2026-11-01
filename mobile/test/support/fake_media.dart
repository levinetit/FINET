import 'dart:convert';

import 'package:finet_mobile/features/receipts/receipts_api.dart';
import 'package:finet_mobile/features/scan/media.dart';

/// Selectorul de poze din teste: întoarce fișiere puse la coadă, fără să deschidă nimic.
class FakeMediaPicker implements MediaPicker {
  final List<PickedMedia> camera = [];
  final List<List<PickedMedia>> gallery = [];
  final List<PickedMedia> documents = [];

  @override
  Future<PickedMedia?> takePhoto() async =>
      camera.isEmpty ? null : camera.removeAt(0);

  @override
  Future<List<PickedMedia>> pickImages({required int limit}) async =>
      gallery.isEmpty ? const [] : gallery.removeAt(0).take(limit).toList();

  @override
  Future<PickedMedia?> pickDocument({required List<String> extensions}) async =>
      documents.isEmpty ? null : documents.removeAt(0);
}

/// Pregătirea fără plugin: octeții depind doar de cale, deci aceeași poză dă aceiași octeți.
/// Numără apelurile, ca testele să vadă că o reîncercare nu recodează poza.
class FakeNormalizer implements MediaNormalizer {
  final Map<String, int> calls = {};

  @override
  Future<UploadFile> normalize(PickedMedia media) async {
    calls[media.path] = (calls[media.path] ?? 0) + 1;
    final isPdf = media.kind == MediaKind.pdf;
    return UploadFile(
      bytes: utf8.encode('octeti:${media.path}'),
      filename: isPdf ? media.name : '${media.name.split('.').first}.jpg',
      mimeType: isPdf ? 'application/pdf' : 'image/jpeg',
    );
  }
}

class FakeTempFiles implements TempFiles {
  final List<String> deleted = [];
  int wipes = 0;

  @override
  Future<void> delete(Iterable<String> paths) async => deleted.addAll(paths);

  @override
  Future<void> wipeAll() async => wipes++;
}
