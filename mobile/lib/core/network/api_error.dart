import 'package:dio/dio.dart';

/// Felul erorii, ca interfața să aleagă mesajul și acțiunea (promptul Android §6, §11).
enum ApiErrorKind {
  /// Fără rețea sau conexiune întreruptă.
  network,

  /// Timeout la conectare, trimitere sau răspuns.
  timeout,

  /// 401: sesiune expirată sau invalidă → ecranul de login, cu datele locale șterse.
  unauthorized,

  /// 403: mesaj clar, fără reîncercări.
  forbidden,

  /// Cloudflare Access a răspuns în loc de FINET (pagina de login Access, 403 Cloudflare).
  accessWall,

  /// 402: abonament necesar (varianta `saas`).
  subscriptionRequired,

  /// 429: prea multe cereri.
  rateLimited,

  /// 4xx cu eroare FINET (validare, conflict, nu există etc.).
  client,

  /// 5xx sau răspuns neașteptat.
  server,
}

/// Eroare normalizată din API: `{ error: { code, message, fields? } }` plus felul ei.
class ApiError implements Exception {
  const ApiError({
    required this.kind,
    required this.message,
    this.code,
    this.status,
    this.fields = const {},
    this.retryAfter,
  });

  final ApiErrorKind kind;
  final String message;
  final String? code;
  final int? status;
  final Map<String, String> fields;

  /// Din antetul `Retry-After` al unui 429, dacă există.
  final Duration? retryAfter;

  /// Mesajul pentru Cloudflare Access (promptul Android §11).
  static const String accessWallMessage =
      'Nu te poți conecta la FINET. Pornește aplicația Cloudflare One și încearcă din nou.';

  /// Codul pentru evenimentul `error_shown`: valorile fixe acceptate de server
  /// (`POST /api/v1/app/events`). Niciodată textul erorii (promptul §10.1).
  String get analyticsCode => switch (kind) {
    ApiErrorKind.network => 'network_unavailable',
    ApiErrorKind.timeout => 'network_timeout',
    ApiErrorKind.unauthorized => 'unauthenticated',
    ApiErrorKind.forbidden || ApiErrorKind.subscriptionRequired => 'forbidden',
    ApiErrorKind.accessWall => 'access_required',
    ApiErrorKind.rateLimited => 'rate_limited',
    ApiErrorKind.server => 'server_error',
    ApiErrorKind.client => switch (status) {
      404 => 'not_found',
      409 => 'conflict',
      400 || 422 => 'validation_failed',
      _ => 'unknown',
    },
  };

  @override
  String toString() => 'ApiError(${kind.name}, status: $status, code: $code)';

  /// Transformă o excepție Dio în [ApiError].
  factory ApiError.fromDio(DioException e) {
    switch (e.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
      case DioExceptionType.transformTimeout:
        return const ApiError(
          kind: ApiErrorKind.timeout,
          message:
              'Serverul nu răspunde. Verifică conexiunea și încearcă din nou.',
        );
      case DioExceptionType.connectionError:
        return const ApiError(
          kind: ApiErrorKind.network,
          message: 'Nu există conexiune la internet.',
        );
      case DioExceptionType.cancel:
        return const ApiError(
          kind: ApiErrorKind.network,
          message: 'Cererea a fost anulată.',
        );
      case DioExceptionType.badCertificate:
        return const ApiError(
          kind: ApiErrorKind.network,
          message: 'Certificatul serverului nu este de încredere.',
        );
      case DioExceptionType.badResponse:
      case DioExceptionType.unknown:
        break;
    }

    final response = e.response;
    if (response == null) {
      return const ApiError(
        kind: ApiErrorKind.network,
        message: 'Nu există conexiune la internet.',
      );
    }
    if (isAccessWall(response)) {
      return const ApiError(
        kind: ApiErrorKind.accessWall,
        message: accessWallMessage,
        code: 'access_wall',
      );
    }
    final status = response.statusCode ?? 0;
    final body = response.data;
    String? code;
    String? message;
    final fields = <String, String>{};
    if (body is Map) {
      // Formatul FINET `{ error: { code, message, fields? } }`; rutele Better Auth
      // (`/api/auth/*`) răspund cu `{ code, message }` la nivelul de sus.
      final error = body['error'] is Map ? body['error'] as Map : body;
      code = error['code'] is String ? error['code'] as String : null;
      message = error['message'] is String ? error['message'] as String : null;
      final f = error['fields'];
      if (f is Map) {
        f.forEach((k, v) {
          if (k is String && v is String) fields[k] = v;
        });
      }
    }
    final kind = switch (status) {
      401 => ApiErrorKind.unauthorized,
      402 => ApiErrorKind.subscriptionRequired,
      403 => ApiErrorKind.forbidden,
      429 => ApiErrorKind.rateLimited,
      >= 400 && < 500 => ApiErrorKind.client,
      _ => ApiErrorKind.server,
    };
    return ApiError(
      kind: kind,
      message: message ?? _fallbackMessage(kind),
      code: code,
      status: status,
      fields: fields,
      retryAfter: _retryAfter(response),
    );
  }

  static Duration? _retryAfter(Response<dynamic> response) {
    final seconds = int.tryParse(response.headers.value('retry-after') ?? '');
    if (seconds == null || seconds < 0 || seconds > 86400) return null;
    return Duration(seconds: seconds);
  }

  static String _fallbackMessage(ApiErrorKind kind) => switch (kind) {
    ApiErrorKind.unauthorized => 'Sesiunea a expirat. Autentifică-te din nou.',
    ApiErrorKind.forbidden => 'Nu ai dreptul să faci această acțiune.',
    ApiErrorKind.subscriptionRequired => 'Este necesar un abonament activ.',
    ApiErrorKind.client => 'Cererea nu a putut fi procesată.',
    _ => 'A apărut o eroare. Încearcă din nou.',
  };

  /// Cloudflare Access: redirect către `cloudflareaccess.com` sau un răspuns Cloudflare (HTML, nu
  /// JSON FINET) în locul API-ului. Un răspuns FINET are mereu corp JSON.
  static bool isAccessWall(Response<dynamic> response) {
    final location = response.headers.value('location') ?? '';
    if (location.contains('cloudflareaccess.com')) return true;
    final status = response.statusCode ?? 0;
    if (status != 302 && status != 401 && status != 403) return false;
    final contentType = response.headers.value('content-type') ?? '';
    final server = response.headers.value('server') ?? '';
    final isHtml = contentType.contains('text/html');
    return isHtml && server.toLowerCase().contains('cloudflare');
  }
}
