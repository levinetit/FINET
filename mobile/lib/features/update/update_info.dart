import '../finance/models.dart';

/// Ultima versiune publicată (`GET /api/v1/app/android/latest`). Datele vin din configurația
/// serverului; aplicația nu instalează nimic singură: deschide linkul, iar instalarea o confirmă
/// utilizatorul prin instalatorul Android.
class UpdateInfo {
  const UpdateInfo({
    required this.versionName,
    required this.versionCode,
    required this.minSupportedVersionCode,
    required this.url,
    required this.sha256,
    required this.notes,
  });

  /// Citire strictă; un link care nu e HTTPS se respinge (nu se deschide niciodată).
  factory UpdateInfo.fromJson(JsonMap m) {
    final url = Uri.tryParse(Json.str(m, 'url'));
    if (url == null || url.scheme != 'https' || url.host.isEmpty) {
      throw const FormatException('Link de descărcare invalid.');
    }
    return UpdateInfo(
      versionName: Json.str(m, 'versionName'),
      versionCode: Json.integer(m, 'versionCode'),
      minSupportedVersionCode: Json.integer(m, 'minSupportedVersionCode'),
      url: url,
      sha256: Json.str(m, 'sha256'),
      notes: Json.str(m, 'notes'),
    );
  }

  final String versionName;
  final int versionCode;
  final int minSupportedVersionCode;
  final Uri url;
  final String sha256;
  final String notes;

  JsonMap toJson() => {
    'versionName': versionName,
    'versionCode': versionCode,
    'minSupportedVersionCode': minSupportedVersionCode,
    'url': url.toString(),
    'sha256': sha256,
    'notes': notes,
  };
}
