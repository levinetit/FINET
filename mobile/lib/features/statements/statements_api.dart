import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_error.dart';
import '../../core/network/interceptors.dart';
import '../finance/models.dart';
import '../receipts/receipts_api.dart';
import 'models.dart';

/// O decizie pentru un rând de schimb valutar. Transferul între conturi (`transfer`) cere un cont
/// de contrapartidă și o sumă: se face din aplicația web.
enum FxChoice {
  skip('skip', 'Sari peste'),
  plain('plain', 'Ca tranzacție obișnuită');

  const FxChoice(this.api, this.label);
  final String api;
  final String label;
}

/// Apelurile pentru extrase bancare (Faza D). Toate aruncă `ApiError`.
class StatementsApi {
  StatementsApi(this._dio, {Future<void> Function(Duration)? sleep})
    : _sleep = sleep ?? Future<void>.delayed;

  final Dio _dio;
  final Future<void> Function(Duration) _sleep;

  Future<JsonMap> _body(Future<Response<dynamic>> Function() call) async {
    final r = await guardApi(call);
    return parseBody(() => Json.map(r.data));
  }

  Future<List<AccountCoverage>> coverage() async {
    final body = await _body(
      () => _dio.get<dynamic>('/api/v1/statements/coverage'),
    );
    return parseBody(
      () => [
        for (final m in Json.list(body['data'])) AccountCoverage.fromJson(m),
      ],
    );
  }

  Future<List<StatementImport>> imports() async {
    final body = await _body(
      () => _dio.get<dynamic>('/api/v1/statements/imports'),
    );
    return parseBody(
      () => [
        for (final m in Json.list(body['data'])) StatementImport.fromJson(m),
      ],
    );
  }

  Future<StatementImport> importById(String id) async {
    final body = await _body(
      () => _dio.get<dynamic>('/api/v1/statements/imports/$id'),
    );
    return parseBody(() => StatementImport.fromJson(Json.map(body['data'])));
  }

  Future<StatementUpload> uploadStatus(String id) async {
    final body = await _body(
      () => _dio.get<dynamic>('/api/v1/statements/uploads/$id'),
    );
    return parseBody(() => StatementUpload.fromJson(Json.map(body['data'])));
  }

  /// Încarcă UN fișier (PDF, CSV, XLSX sau ZIP) pe un cont. `accountId` merge înaintea
  /// fișierului. Corpul se reconstruiește din aceiași octeți la fiecare încercare; se reîncearcă
  /// doar erorile de rețea.
  Future<List<UploadPart>> upload(String accountId, UploadFile file) async {
    ApiError? last;
    for (var attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await _sleep(Duration(milliseconds: 400 * attempt));
      try {
        final form = FormData();
        form.fields.add(MapEntry('accountId', accountId));
        form.files.add(
          MapEntry(
            'file',
            MultipartFile.fromBytes(
              file.bytes,
              filename: file.filename,
              contentType: DioMediaType.parse(file.mimeType),
            ),
          ),
        );
        final body = await _body(
          () => _dio.post<dynamic>(
            '/api/v1/statements/uploads',
            data: form,
            options: Options(
              extra: {RetryInterceptor.noRetryKey: true},
              contentType: Headers.multipartFormDataContentType,
              sendTimeout: uploadSendTimeout,
              receiveTimeout: uploadReceiveTimeout,
            ),
          ),
        );
        final parts = parseBody(() {
          final data = Json.map(body['data']);
          return [
            for (final p in Json.list(data['parts'])) UploadPart.fromJson(p),
          ];
        });
        return parts;
      } on ApiError catch (e) {
        final network =
            e.kind == ApiErrorKind.network || e.kind == ApiErrorKind.timeout;
        if (!network) rethrow;
        last = e;
      }
    }
    throw last!;
  }

  Future<StatementImport> confirm(
    String id, {
    required String idempotencyKey,
    bool acknowledgeBalanceMismatch = false,
    Map<int, FxChoice> fx = const {},
  }) async {
    final body = await _body(
      () => _dio.post<dynamic>(
        '/api/v1/statements/imports/$id/confirm',
        data: {
          if (acknowledgeBalanceMismatch) 'acknowledgeBalanceMismatch': true,
          if (fx.isNotEmpty)
            'fx': [
              for (final e in fx.entries) {'rowNo': e.key, 'mode': e.value.api},
            ],
        },
        options: Options(headers: {'Idempotency-Key': idempotencyKey}),
      ),
    );
    return parseBody(() => StatementImport.fromJson(Json.map(body['data'])));
  }

  /// Renunță la o previzualizare neconfirmată.
  Future<void> discard(String id) async {
    await guardApi(
      () => _dio.delete<dynamic>('/api/v1/statements/imports/$id'),
    );
  }

  /// Anulează un import confirmat: șterge DOAR tranzacțiile create de el.
  Future<void> cancel(String id) async {
    await guardApi(
      () => _dio.post<dynamic>(
        '/api/v1/statements/imports/$id/cancel',
        data: const {},
      ),
    );
  }
}
