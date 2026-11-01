import 'package:finet_mobile/core/client/client_info.dart';
import 'package:finet_mobile/core/storage/key_value_store.dart';
import 'package:flutter_test/flutter_test.dart';

// Aceleași reguli ca `parseClientInfo` din `src/modules/auth/request.ts`: antet invalid = ignorat
// de server, deci instalarea nu s-ar înregistra.
final _model = RegExp(r'^[0-9A-Za-z .+_()-]{1,64}$');

ClientInfo info({
  String model = 'Google Pixel 8',
  String os = '14',
  String version = '0.2.0',
}) => ClientInfo(
  installationId: '3F1C2B4A-5D6E-4F70-8A9B-0C1D2E3F4A5B',
  versionName: version,
  versionCode: 2,
  osVersion: os,
  model: model,
);

Map<String, String> parse(String header) {
  final out = <String, String>{};
  for (final part in header.split(';')) {
    final item = part.trim();
    final eq = item.indexOf('=');
    out[item.substring(0, eq)] = item.substring(eq + 1);
  }
  return out;
}

void main() {
  test('antetul are forma completă și cheile permise', () {
    final header = info().toHeader();
    final map = parse(header);
    expect(map.keys, [
      'platform',
      'version',
      'code',
      'installation',
      'os',
      'model',
      'locale',
    ]);
    expect(map['platform'], 'android');
    expect(map['installation'], '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b');
    expect(map['code'], '2');
    expect(map['locale'], 'ro-RO');
    expect(header.length, lessThanOrEqualTo(400));
    expect(RegExp(r'^[\x20-\x7e]+$').hasMatch(header), isTrue);
  });

  test('modelul cu caractere nepermise se curăță, nu strică antetul', () {
    final header = info(model: 'Samsung SM-A546B™ «5G»;DROP').toHeader();
    final map = parse(header);
    expect(_model.hasMatch(map['model']!), isTrue, reason: map['model']);
    expect(map.keys, contains('installation'));
  });

  test('valorile prea lungi se taie la 64 de caractere', () {
    expect(ClientInfo.sanitize('x' * 200).length, 64);
  });

  test('valori goale după curățare se omit', () {
    final map = parse(info(model: '™™', os: '').toHeader());
    expect(map.containsKey('model'), isFalse);
    expect(map.containsKey('os'), isFalse);
    expect(map.containsKey('installation'), isTrue);
  });

  test('versiunea cu caractere nepermise se curăță', () {
    expect(
      parse(info(version: '1.0.2 (debug)').toHeader())['version'],
      '1.0.2debug',
    );
  });

  group('identificatorul instalării', () {
    test('se creează o dată și rămâne același', () async {
      final store = MemoryKeyValueStore();
      final first = await loadOrCreateInstallationId(store);
      final second = await loadOrCreateInstallationId(store);
      expect(first, second);
      expect(
        first,
        matches(
          RegExp(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
          ),
        ),
      );
    });

    test('o valoare coruptă se înlocuiește', () async {
      final store = MemoryKeyValueStore({
        StoreKeys.installationId: 'nu-e-uuid',
      });
      final id = await loadOrCreateInstallationId(store);
      expect(id, isNot('nu-e-uuid'));
      expect(store.values[StoreKeys.installationId], id);
    });
  });
}
