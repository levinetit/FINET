/// Configurația pe medii (promptul Android §11). Valorile vin la build prin `--dart-define`; ele
/// NU sunt secrete (se pot extrage din APK).
library;

class AppEnv {
  const AppEnv({required this.apiBaseUrl, required this.useMockData});

  /// Citește `--dart-define=API_BASE_URL=...` și `--dart-define=USE_MOCK_DATA=...`.
  /// În Faza A toate ecranele sunt pe date simulate, deci `USE_MOCK_DATA` e implicit `true`.
  factory AppEnv.fromEnvironment() => const AppEnv(
    apiBaseUrl: String.fromEnvironment('API_BASE_URL'),
    useMockData: bool.fromEnvironment('USE_MOCK_DATA', defaultValue: true),
  );

  final String apiBaseUrl;
  final bool useMockData;

  /// Problemele de configurare, în română; lista goală înseamnă că totul e în regulă.
  ///
  /// - Release: doar HTTPS, fără `localhost` și `10.0.2.2`, fără date simulate.
  /// - Debug: HTTPS sau HTTP către emulator (`10.0.2.2`) / `localhost`.
  /// - Cu date simulate, adresa serverului nu e obligatorie.
  List<String> validate({required bool isRelease}) {
    final problems = <String>[];
    if (isRelease && useMockData) {
      problems.add('Build-ul release nu poate folosi date simulate.');
    }
    if (apiBaseUrl.isEmpty) {
      if (!useMockData) problems.add('Lipsește API_BASE_URL.');
      return problems;
    }
    final uri = Uri.tryParse(apiBaseUrl);
    if (uri == null || !uri.hasScheme || uri.host.isEmpty) {
      problems.add('API_BASE_URL nu este o adresă validă.');
      return problems;
    }
    final local =
        uri.host == 'localhost' ||
        uri.host == '10.0.2.2' ||
        uri.host == '127.0.0.1';
    if (isRelease) {
      if (uri.scheme != 'https') {
        problems.add('În release API_BASE_URL trebuie să fie HTTPS.');
      }
      if (local) {
        problems.add('În release API_BASE_URL nu poate fi o adresă locală.');
      }
    } else if (uri.scheme != 'https' && !(uri.scheme == 'http' && local)) {
      problems.add(
        'HTTP este permis doar către emulator (10.0.2.2) sau localhost.',
      );
    }
    return problems;
  }
}
