/// Configurația pe medii (promptul Android §11). Valorile vin la build prin `--dart-define`; ele
/// NU sunt secrete (se pot extrage din APK).
library;

class AppEnv {
  const AppEnv({required this.apiBaseUrl, this.usageStatsDefault = true});

  /// Citește `--dart-define=API_BASE_URL=...` și `--dart-define=USAGE_STATS_DEFAULT=...`.
  factory AppEnv.fromEnvironment() => const AppEnv(
    apiBaseUrl: String.fromEnvironment('API_BASE_URL'),
    usageStatsDefault: bool.fromEnvironment(
      'USAGE_STATS_DEFAULT',
      defaultValue: true,
    ),
  );

  /// Adresa serverului FINET, fără `/` la final (o dă operatorul; nu se inventează).
  final String apiBaseUrl;

  /// Valoarea implicită a statisticilor de utilizare la prima pornire: `true` în `personal`, `false`
  /// în `saas` (acolo cer acordul explicit, promptul Android §10.1).
  final bool usageStatsDefault;

  /// Problemele de configurare, în română; lista goală înseamnă că totul e în regulă.
  ///
  /// - Release: doar HTTPS, fără `localhost` și `10.0.2.2`.
  /// - Debug: HTTPS sau HTTP către emulator (`10.0.2.2`) / `localhost`.
  List<String> validate({required bool isRelease}) {
    final problems = <String>[];
    if (apiBaseUrl.isEmpty) {
      problems.add('Lipsește API_BASE_URL.');
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
