import 'dart:io';
import 'dart:ui' as ui;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_image_compress/flutter_image_compress.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';

import '../receipts/receipts_api.dart';

/// Ce fel de fișier a ales utilizatorul, după extensie.
enum MediaKind { image, pdf, csv, spreadsheet, unsupported }

MediaKind mediaKindOf(String name) {
  final dot = name.lastIndexOf('.');
  final ext = dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  return switch (ext) {
    'jpg' || 'jpeg' || 'png' || 'webp' || 'heic' || 'heif' => MediaKind.image,
    'pdf' => MediaKind.pdf,
    'csv' => MediaKind.csv,
    'xlsx' => MediaKind.spreadsheet,
    _ => MediaKind.unsupported,
  };
}

/// Un fișier ales sau primit prin „Partajează”, deja pe disc în memoria temporară a aplicației.
class PickedMedia {
  PickedMedia({required this.path, required this.name})
    : kind = mediaKindOf(name);

  final String path;
  final String name;
  final MediaKind kind;
}

/// Alegerea fișierelor. Camera folosește intentul sistemului (fără permisiunea de cameră în APK);
/// galeria folosește selectorul de poze al Android (fără permisiune de stocare). Interfața
/// permite înlocuirea în teste.
abstract class MediaPicker {
  Future<PickedMedia?> takePhoto();
  Future<List<PickedMedia>> pickImages({required int limit});
  Future<PickedMedia?> pickDocument({required List<String> extensions});
}

class SystemMediaPicker implements MediaPicker {
  SystemMediaPicker({ImagePicker? images}) : _images = images ?? ImagePicker();

  final ImagePicker _images;

  @override
  Future<PickedMedia?> takePhoto() async {
    final x = await _images.pickImage(source: ImageSource.camera);
    return x == null ? null : PickedMedia(path: x.path, name: x.name);
  }

  @override
  Future<List<PickedMedia>> pickImages({required int limit}) async {
    final xs = limit == 1
        ? [?await _images.pickImage(source: ImageSource.gallery)]
        : await _images.pickMultiImage(limit: limit);
    return [for (final x in xs) PickedMedia(path: x.path, name: x.name)];
  }

  @override
  Future<PickedMedia?> pickDocument({required List<String> extensions}) async {
    final f = await FilePicker.pickFile(
      type: FileType.custom,
      allowedExtensions: extensions,
    );
    final path = f?.path;
    if (f == null || path == null) return null;
    return PickedMedia(path: path, name: f.name);
  }
}

/// Latura maximă a pozei trimise (promptul Android, Faza D: ~2000 px).
const int maxImageSide = 2000;

/// Valoarea `minWidth`/`minHeight` pentru pluginul de comprimare, ca latura mare să ajungă la
/// [maxImageSide]. Pluginul scalează cu `min(lățime/min, înălțime/min)`, adică după latura mică;
/// de aceea `min = latura mică × 2000 / latura mare`. O poză deja mai mică nu se mărește.
int compressionMin(int width, int height, {int maxSide = maxImageSide}) {
  final longSide = width > height ? width : height;
  final shortSide = width > height ? height : width;
  if (longSide <= maxSide) return shortSide;
  return (shortSide * maxSide / longSide).round();
}

/// Pregătește fișierul pentru încărcare: poze → JPEG fără EXIF, rotite corect, cu latura mare de
/// cel mult 2000 px; PDF-urile și CSV/XLSX se trimit neschimbate. Octeții rezultați rămân aceiași
/// la toate reîncercările.
abstract class MediaNormalizer {
  Future<UploadFile> normalize(PickedMedia media);
}

class NativeMediaNormalizer implements MediaNormalizer {
  const NativeMediaNormalizer();

  @override
  Future<UploadFile> normalize(PickedMedia media) async {
    switch (media.kind) {
      case MediaKind.pdf:
        return UploadFile(
          bytes: await File(media.path).readAsBytes(),
          filename: media.name,
          mimeType: 'application/pdf',
        );
      case MediaKind.csv:
        return UploadFile(
          bytes: await File(media.path).readAsBytes(),
          filename: media.name,
          mimeType: 'text/csv',
        );
      case MediaKind.spreadsheet:
        return UploadFile(
          bytes: await File(media.path).readAsBytes(),
          filename: media.name,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
      case MediaKind.image:
        final min = await _minFor(media.path);
        // `keepExif: false` șterge locația și datele aparatului; `autoCorrectionAngle` aplică
        // rotirea din EXIF înainte de ștergere (altfel bonul ar ieși pe o parte).
        final bytes = await FlutterImageCompress.compressWithFile(
          media.path,
          minWidth: min,
          minHeight: min,
          quality: 85,
          format: CompressFormat.jpeg,
          keepExif: false,
          autoCorrectionAngle: true,
        );
        if (bytes == null || bytes.isEmpty) {
          throw const FormatException('Poza nu a putut fi pregătită.');
        }
        return UploadFile(
          bytes: Uint8List.fromList(bytes),
          filename: '${_stem(media.name)}.jpg',
          mimeType: 'image/jpeg',
        );
      case MediaKind.unsupported:
        throw const FormatException('Tip de fișier neacceptat.');
    }
  }

  static String _stem(String name) {
    final dot = name.lastIndexOf('.');
    return dot <= 0 ? name : name.substring(0, dot);
  }

  /// Dimensiunile din antetul pozei (fără decodare completă). Dacă nu se pot citi, o valoare
  /// sigură: poza se aduce la ~1500 px pe latura mică.
  static Future<int> _minFor(String path) async {
    try {
      final buffer = await ui.ImmutableBuffer.fromFilePath(path);
      try {
        final descriptor = await ui.ImageDescriptor.encoded(buffer);
        final min = compressionMin(descriptor.width, descriptor.height);
        descriptor.dispose();
        return min;
      } finally {
        buffer.dispose();
      }
    } on Object {
      return 1500;
    }
  }
}

/// Fișierele temporare (poze, partajări) se șterg după ce serverul confirmă primirea și la
/// deconectare.
abstract class TempFiles {
  Future<void> delete(Iterable<String> paths);
  Future<void> wipeAll();
}

class SystemTempFiles implements TempFiles {
  const SystemTempFiles();

  @override
  Future<void> delete(Iterable<String> paths) async {
    for (final p in paths) {
      try {
        final f = File(p);
        if (f.existsSync()) await f.delete();
      } on FileSystemException catch (e) {
        debugPrint('Fișier temporar rămas: ${e.osError?.errorCode}');
      }
    }
  }

  @override
  Future<void> wipeAll() async {
    try {
      final cache = await getTemporaryDirectory();
      for (final name in const ['image_picker', 'file_picker', 'finet_share']) {
        final dir = Directory('${cache.path}/$name');
        if (dir.existsSync()) await dir.delete(recursive: true);
      }
      await FilePicker.clearTemporaryFiles();
    } on Object catch (e) {
      debugPrint('Curățarea fișierelor temporare a eșuat: $e');
    }
  }
}
