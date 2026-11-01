import 'package:finet_mobile/core/config/env.dart';
import 'package:flutter_test/flutter_test.dart';

AppEnv env(String url) => AppEnv(apiBaseUrl: url);

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

    test('adresa e obligatorie (nu mai există date simulate)', () {
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
          usageStatsDefault: false,
        ).usageStatsDefault,
        isFalse,
      );
    });
  });
}
