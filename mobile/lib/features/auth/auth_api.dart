import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_error.dart';
import 'models.dart';

/// Apelurile de autentificare și de profil către FINET. Toate aruncă [ApiError].
class AuthApi {
  AuthApi(this._dio);

  final Dio _dio;

  /// `POST /api/auth/sign-in/email`. Tokenul de sesiune e antetul `set-auth-token` din răspuns;
  /// se întoarce ca atare și nu se pune în niciun log.
  Future<String> login(String email, String password) async {
    try {
      final response = await _dio.post<dynamic>(
        '/api/auth/sign-in/email',
        data: {'email': email.trim(), 'password': password},
      );
      final token = response.headers.value('set-auth-token');
      if (token == null || token.isEmpty) {
        throw const ApiError(
          kind: ApiErrorKind.server,
          message: 'Răspuns neașteptat de la server. Încearcă din nou.',
        );
      }
      return token;
    } on DioException catch (e) {
      final error = ApiError.fromDio(e);
      throw _loginError(error);
    }
  }

  /// Mesaje clare în română pentru erorile de autentificare (Better Auth răspunde în engleză).
  static ApiError _loginError(ApiError e) {
    if (e.kind == ApiErrorKind.unauthorized ||
        e.code == 'INVALID_EMAIL_OR_PASSWORD') {
      return const ApiError(
        kind: ApiErrorKind.client,
        message: 'Email sau parolă incorecte.',
        code: 'invalid_credentials',
        status: 401,
      );
    }
    if (e.code == 'EMAIL_NOT_VERIFIED') {
      return const ApiError(
        kind: ApiErrorKind.forbidden,
        message: 'Confirmă adresa de email înainte de autentificare.',
        code: 'email_not_verified',
        status: 403,
      );
    }
    if (e.kind == ApiErrorKind.forbidden) {
      return const ApiError(
        kind: ApiErrorKind.forbidden,
        message: 'Contul nu poate fi folosit. Contactează administratorul.',
        code: 'forbidden',
        status: 403,
      );
    }
    return e;
  }

  /// `POST /api/auth/sign-out` cu tokenul curent: revocă sesiunea pe server.
  Future<void> logout() => guardApi(
    () => _dio.post<dynamic>('/api/auth/sign-out', data: <String, Object?>{}),
  );

  /// `GET /api/v1/me`.
  Future<Profile> me() async {
    final response = await guardApi(() => _dio.get<dynamic>('/api/v1/me'));
    return _parse(() => Profile.fromJson((response.data as Map)['data']));
  }

  /// `GET /api/v1/households`.
  Future<List<HouseholdInfo>> households() async {
    final response = await guardApi(
      () => _dio.get<dynamic>('/api/v1/households'),
    );
    return _parse(() {
      final data = (response.data as Map)['data'] as List;
      return [
        for (final item in data)
          HouseholdInfo.fromJson(Map<String, Object?>.from(item as Map)),
      ];
    });
  }

  /// `PUT /api/v1/households/active`.
  Future<HouseholdInfo> setActiveHousehold(String householdId) async {
    final response = await guardApi(
      () => _dio.put<dynamic>(
        '/api/v1/households/active',
        data: {'householdId': householdId},
      ),
    );
    return _parse(
      () => HouseholdInfo.fromJson(
        Map<String, Object?>.from((response.data as Map)['data'] as Map),
      ),
    );
  }

  /// `GET /api/v1/me/consents`: dacă statisticile de utilizare sunt acordate pe server.
  Future<bool> usageStatsGranted() async {
    final response = await guardApi(
      () => _dio.get<dynamic>('/api/v1/me/consents'),
    );
    return _parse(() {
      for (final item in (response.data as Map)['data'] as List) {
        final map = item as Map;
        if (map['kind'] == 'usageStats') return map['granted'] == true;
      }
      return false;
    });
  }

  /// `PUT /api/v1/me/consents` pentru `usageStats`.
  Future<void> setUsageStats({required bool granted}) async {
    await guardApi(
      () => _dio.put<dynamic>(
        '/api/v1/me/consents',
        data: {'usageStats': granted},
      ),
    );
  }

  /// Un răspuns cu altă formă decât cea așteptată devine eroare de server, nu o excepție
  /// necontrolată.
  static T _parse<T>(T Function() read) {
    try {
      return read();
    } on Object {
      throw const ApiError(
        kind: ApiErrorKind.server,
        message: 'Răspuns neașteptat de la server.',
      );
    }
  }
}
