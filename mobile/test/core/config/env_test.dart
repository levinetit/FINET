import 'package:finet_mobile/core/config/env.dart';
import 'package:flutter_test/flutter_test.dart';

AppEnv env(String url, {bool mock = false}) =>
    AppEnv(apiBaseUrl: url, useMockData: mock);

void main() {
  group('release', () {
    test('HTTPS cu domeniu public este acceptat', () {
      expect(
        env('https://finet.exemplu.test').validate(isRelease: true),
        isEmpty,
      );
    });

    test('HTTP, localhost și 10.0.2.2 sunt respinse', () {
      expect(
        env('http://finet.exemplu.test').validate(isRelease: true),
        isNotEmpty,
      );
      expect(env('https://localhost').validate(isRelease: true), isNotEmpty);
      expect(env('https://10.0.2.2').validate(isRelease: true), isNotEmpty);
    });

    test('datele simulate sunt respinse', () {
      expect(
        env('https://finet.exemplu.test', mock: true).validate(isRelease: true),
        isNotEmpty,
      );
    });

    test('lipsa adresei este respinsă', () {
      expect(env('').validate(isRelease: true), isNotEmpty);
    });
  });

  group('debug', () {
    test('HTTP este permis doar către emulator și localhost', () {
      expect(env('http://10.0.2.2:3000').validate(isRelease: false), isEmpty);
      expect(env('http://localhost:3000').validate(isRelease: false), isEmpty);
      expect(
        env('http://finet.exemplu.test').validate(isRelease: false),
        isNotEmpty,
      );
    });

    test('cu date simulate adresa nu e obligatorie', () {
      expect(env('', mock: true).validate(isRelease: false), isEmpty);
    });

    test('fără date simulate adresa e obligatorie', () {
      expect(env('').validate(isRelease: false), isNotEmpty);
    });

    test('adresă fără schemă sau fără host este respinsă', () {
      expect(env('finet.exemplu.test').validate(isRelease: false), isNotEmpty);
      expect(env('https://').validate(isRelease: false), isNotEmpty);
    });
  });

  group('statistici', () {
    test('implicit pornite (personal); saas le poate opri la build', () {
      expect(env('https://x.test').usageStatsDefault, isTrue);
      expect(
        const AppEnv(
          apiBaseUrl: '',
          useMockData: true,
          usageStatsDefault: false,
        ).usageStatsDefault,
        isFalse,
      );
    });
  });
}
