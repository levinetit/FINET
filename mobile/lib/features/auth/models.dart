import '../../core/money/money.dart';

/// Utilizatorul curent (`GET /api/v1/me`, câmpul `user`).
class UserInfo {
  const UserInfo({required this.id, required this.email, required this.name});

  factory UserInfo.fromJson(Map<String, Object?> json) => UserInfo(
    id: _str(json, 'id'),
    email: _str(json, 'email'),
    name: _str(json, 'name'),
  );

  final String id;
  final String email;
  final String name;
}

/// Gospodăria, cu rolul utilizatorului în ea (`owner` sau `member`).
class HouseholdInfo {
  const HouseholdInfo({
    required this.id,
    required this.name,
    required this.role,
    required this.currency,
    this.current = false,
    this.timezone = 'Europe/Bucharest',
  });

  /// Din `GET /api/v1/households` (`HouseholdSummary`) sau din `Me.household`.
  factory HouseholdInfo.fromJson(Map<String, Object?> json) => HouseholdInfo(
    id: _str(json, 'id'),
    name: _str(json, 'name'),
    role: _str(json, 'role'),
    currency: Currency.tryParse(json['defaultCurrency']) ?? Currency.ron,
    current: json['current'] == true,
    timezone: json['timezone'] is String
        ? json['timezone']! as String
        : 'Europe/Bucharest',
  );

  final String id;
  final String name;
  final String role;
  final Currency currency;
  final bool current;

  /// Fusul orar al gospodăriei (IANA); „azi” și luna curentă se calculează în el.
  final String timezone;

  bool get isOwner => role == 'owner';
}

/// Profilul din `GET /api/v1/me`: utilizatorul și gospodăria curentă (poate lipsi).
class Profile {
  const Profile({required this.user, this.household});

  factory Profile.fromJson(Object? json) {
    if (json is! Map) throw const FormatException('Profil invalid.');
    final map = Map<String, Object?>.from(json);
    final user = map['user'];
    final household = map['household'];
    if (user is! Map) throw const FormatException('Profil invalid.');
    return Profile(
      user: UserInfo.fromJson(Map<String, Object?>.from(user)),
      household: household is Map
          ? HouseholdInfo.fromJson({
              ...Map<String, Object?>.from(household),
              'current': true,
            })
          : null,
    );
  }

  final UserInfo user;
  final HouseholdInfo? household;
}

String _str(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is! String) throw FormatException('Câmp lipsă: $key');
  return value;
}
