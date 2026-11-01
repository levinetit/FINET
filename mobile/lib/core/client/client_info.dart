import 'dart:io' show Platform;

import 'package:device_info_plus/device_info_plus.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:uuid/uuid.dart';

import '../storage/key_value_store.dart';

/// Datele clientului din antetul `X-FINET-Client` (promptul Android §10.1, `docs/API.md`):
/// instalarea (UUID aleator, nu un identificator al telefonului), versiunea aplicației, Android,
/// modelul și limba. Nimic financiar și niciun identificator hardware.
class ClientInfo {
  const ClientInfo({
    required this.installationId,
    required this.versionName,
    required this.versionCode,
    required this.osVersion,
    required this.model,
    this.locale = 'ro-RO',
  });

  final String installationId;
  final String versionName;
  final int versionCode;
  final String osVersion;
  final String model;
  final String locale;

  /// Valoarea antetului, în forma completă cerută de server:
  /// `platform=android; version=1.0.2; code=10002; installation=<uuid>; os=14; model=...`.
  /// Serverul ignoră tăcut un antet invalid, deci fiecare valoare e curățată aici.
  String toHeader() {
    final parts = <String>[
      'platform=android',
      if (_version(versionName).isNotEmpty) 'version=${_version(versionName)}',
      if (versionCode > 0 && versionCode <= 2100000000) 'code=$versionCode',
      'installation=${installationId.toLowerCase()}',
      if (sanitize(osVersion).isNotEmpty) 'os=${sanitize(osVersion)}',
      if (sanitize(model).isNotEmpty) 'model=${sanitize(model)}',
      if (RegExp(r'^[a-z]{2}(-[A-Z]{2})?$').hasMatch(locale)) 'locale=$locale',
    ];
    return parts.join('; ');
  }

  static String _version(String v) {
    final clean = v.replaceAll(RegExp(r'[^0-9A-Za-z.+_-]'), '');
    return clean.length > 32 ? clean.substring(0, 32) : clean;
  }

  /// Păstrează doar caracterele acceptate de server (`[0-9A-Za-z .+_()-]`), cel mult 64.
  static String sanitize(String value) {
    final clean = value.replaceAll(RegExp(r'[^0-9A-Za-z .+_()-]'), '').trim();
    return clean.length > 64 ? clean.substring(0, 64).trim() : clean;
  }
}

/// UUID-ul instalării: se generează o singură dată și se păstrează în stocarea securizată.
Future<String> loadOrCreateInstallationId(
  KeyValueStore store, {
  Uuid uuid = const Uuid(),
}) async {
  final existing = await store.read(StoreKeys.installationId);
  if (existing != null && RegExp(r'^[0-9a-f-]{36}$').hasMatch(existing)) {
    return existing;
  }
  final created = uuid.v4();
  await store.write(StoreKeys.installationId, created);
  return created;
}

/// Citește versiunea aplicației și datele dispozitivului din platformă.
Future<ClientInfo> loadClientInfo(KeyValueStore store) async {
  final installationId = await loadOrCreateInstallationId(store);
  final package = await PackageInfo.fromPlatform();
  var model = 'Android';
  var os = '';
  if (Platform.isAndroid) {
    final android = await DeviceInfoPlugin().androidInfo;
    model = '${android.manufacturer} ${android.model}';
    os = android.version.release;
  }
  return ClientInfo(
    installationId: installationId,
    versionName: package.version,
    versionCode: int.tryParse(package.buildNumber) ?? 0,
    osVersion: os,
    model: model,
  );
}
