import 'dart:typed_data';

import 'package:dio/dio.dart';

import '../../core/network/api_client.dart';
import '../../core/network/api_error.dart';
import '../../core/network/interceptors.dart';
import '../finance/models.dart';
import 'models.dart';

/// Un fișier gata de încărcat: octeții rămân aceiași la fiecare reîncercare, deoarece serverul
/// recunoaște duplicatele după SHA-256 (o recodare ar crea un duplicat real).
class UploadFile {
  const UploadFile({
    required this.bytes,
    required this.filename,
    required this.mimeType,
  });

  final Uint8List bytes;
  final String filename;
  final String mimeType;
}

/// Modificările unui bon aflat „De verificat”. Doar câmpurile setate se trimit.
class ReceiptPatch {
  const ReceiptPatch({
    this.merchantName,
    this.setMerchantName = false,
    this.occurredOn,
    this.totalMinor,
    this.lines,
  });

  final String? merchantName;
  final bool setMerchantName;
  final String? occurredOn;
  final int? totalMinor;

  /// Lista completă a liniilor (serverul o înlocuiește).
  final List<Map<String, Object?>>? lines;

  Map<String, Object?> toJson() => {
    if (setMerchantName) 'merchantName': merchantName,
    'occurredOn': ?occurredOn,
    'totalMinor': ?totalMinor,
    'lines': ?lines,
  };
}

/// Apelurile pentru documente, bonuri și potriviri (Faza D). Toate aruncă `ApiError`.
class ReceiptsApi {
  ReceiptsApi(this._dio, {Future<void> Function(Duration)? sleep})
    : _sleep = sleep ?? Future<void>.delayed;

  final Dio _dio;
  final Future<void> Function(Duration) _sleep;

  Future<JsonMap> _body(Future<Response<dynamic>> Function() call) async {
    final r = await guardApi(call);
    return parseBody(() => Json.map(r.data));
  }

  Future<AiUsage> aiUsage() async {
    final body = await _body(() => _dio.get<dynamic>('/api/v1/ai/usage'));
    return parseBody(() => AiUsage.fromJson(Json.map(body['data'])));
  }

  /// Încarcă 1–4 poze sau un PDF. Câmpurile text merg ÎNAINTEA fișierelor (serverul citește
  /// fluxul). `FormData` se construiește din nou la fiecare încercare, din aceiași octeți; se
  /// reîncearcă doar erorile de rețea, de cel mult două ori.
  Future<UploadResult> upload(
    List<UploadFile> files, {
    bool longReceipt = false,
  }) async {
    ApiError? last;
    for (var attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await _sleep(Duration(milliseconds: 400 * attempt));
      try {
        final form = FormData();
        form.fields
          ..add(const MapEntry('kind', 'receipt'))
          ..add(MapEntry('longReceipt', longReceipt ? 'true' : 'false'));
        for (final f in files) {
          form.files.add(
            MapEntry(
              'files',
              MultipartFile.fromBytes(
                f.bytes,
                filename: f.filename,
                contentType: DioMediaType.parse(f.mimeType),
              ),
            ),
          );
        }
        final body = await _body(
          () => _dio.post<dynamic>(
            '/api/v1/documents',
            data: form,
            options: Options(
              extra: {RetryInterceptor.noRetryKey: true},
              contentType: Headers.multipartFormDataContentType,
            ),
          ),
        );
        final result = parseBody(
          () => UploadResult.fromJson(Json.map(body['data'])),
        );
        return result;
      } on ApiError catch (e) {
        final network =
            e.kind == ApiErrorKind.network || e.kind == ApiErrorKind.timeout;
        if (!network) rethrow;
        last = e;
      }
    }
    throw last!;
  }

  Future<DocumentInfo> document(String id) async {
    final body = await _body(() => _dio.get<dynamic>('/api/v1/documents/$id'));
    return parseBody(() => DocumentInfo.fromJson(Json.map(body['data'])));
  }

  Future<ReceiptPage> receipts({
    ReceiptStatus? status,
    String? cursor,
    int limit = 30,
  }) async {
    final body = await _body(
      () => _dio.get<dynamic>(
        '/api/v1/receipts',
        queryParameters: {
          if (status != null) 'status': status.api,
          'cursor': ?cursor,
          'limit': '$limit',
        },
      ),
    );
    return parseBody(
      () => ReceiptPage(
        items: [for (final m in Json.list(body['data'])) Receipt.fromJson(m)],
        nextCursor: Json.strOrNull(body, 'nextCursor'),
      ),
    );
  }

  Future<Receipt> receipt(String id) async {
    final body = await _body(() => _dio.get<dynamic>('/api/v1/receipts/$id'));
    return parseBody(() => Receipt.fromJson(Json.map(body['data'])));
  }

  Future<Receipt> patchReceipt(String id, ReceiptPatch patch) async {
    final body = await _body(
      () => _dio.patch<dynamic>('/api/v1/receipts/$id', data: patch.toJson()),
    );
    return parseBody(() => Receipt.fromJson(Json.map(body['data'])));
  }

  /// „Confirmă și salvează": creează cheltuiala. `allowDuplicate` doar după acordul explicit al
  /// utilizatorului, când serverul a semnalat un posibil duplicat.
  Future<Receipt> confirm(
    String id, {
    required String accountId,
    required String idempotencyKey,
    String? categoryId,
    bool allowDuplicate = false,
  }) async {
    final body = await _body(
      () => _dio.post<dynamic>(
        '/api/v1/receipts/$id/confirm',
        data: {
          'accountId': accountId,
          'categoryId': ?categoryId,
          if (allowDuplicate) 'allowDuplicate': true,
        },
        options: Options(headers: {'Idempotency-Key': idempotencyKey}),
      ),
    );
    return parseBody(() {
      final data = Json.map(body['data']);
      return Receipt.fromJson(Json.map(data['receipt']));
    });
  }

  Future<void> deleteReceipt(String id) async {
    await guardApi(() => _dio.delete<dynamic>('/api/v1/receipts/$id'));
  }

  Future<void> reprocess(String id, {required String idempotencyKey}) async {
    await guardApi(
      () => _dio.post<dynamic>(
        '/api/v1/receipts/$id/reprocess',
        data: const {},
        options: Options(headers: {'Idempotency-Key': idempotencyKey}),
      ),
    );
  }

  /// Propunerile de potrivire ale unui bon; `null` când nu există nicio propunere.
  Future<ReceiptMatches?> matches(String receiptId) async {
    final body = await _body(
      () => _dio.get<dynamic>('/api/v1/receipts/$receiptId/matches'),
    );
    final data = body['data'];
    if (data == null) return null;
    return parseBody(() => ReceiptMatches.fromJson(Json.map(data)));
  }

  Future<MatchDecisionResult> decideMatch(
    String receiptId, {
    required String transactionId,
    required bool confirm,
  }) async {
    final body = await _body(
      () => _dio.post<dynamic>(
        '/api/v1/receipts/$receiptId/matches',
        data: {
          'transactionId': transactionId,
          'decision': confirm ? 'confirm' : 'reject',
        },
      ),
    );
    return parseBody(
      () => MatchDecisionResult.fromJson(Json.map(body['data'])),
    );
  }

  /// Coada globală: bonurile cu cel puțin o tranzacție din extras propusă.
  Future<List<ReceiptMatches>> matchQueue() async {
    final body = await _body(() => _dio.get<dynamic>('/api/v1/matches'));
    return parseBody(
      () => [
        for (final m in Json.list(body['data'])) ReceiptMatches.fromJson(m),
      ],
    );
  }
}
