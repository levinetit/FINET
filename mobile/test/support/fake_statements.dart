import 'package:dio/dio.dart';

import 'fake_server.dart';
import 'multipart.dart';

/// Extrase bancare pe [FakeServer]: acoperire, previzualizare, PDF în coadă, confirmare.
class FakeStatements {
  FakeStatements(this.server) {
    server.on('GET /api/v1/statements/coverage', (o) {
      if (!server.authorized(o)) return _unauth();
      return jsonBody({
        'data': [
          {
            'accountId': FakeServer.accCurrent,
            'accountName': 'Cont curent',
            'currency': 'RON',
            'months': [
              {
                'month': '2026-09',
                'status': 'complete',
                'coveredUntil': null,
                'fromStart': true,
              },
              {
                'month': '2026-10',
                'status': 'partial',
                'coveredUntil': '2026-10-15',
                'fromStart': true,
              },
              {
                'month': '2026-08',
                'status': 'missing',
                'coveredUntil': null,
                'fromStart': false,
              },
            ],
            'missingMonths': ['2026-08'],
          },
        ],
      });
    });
    server.on('GET /api/v1/statements/imports', (o) {
      if (!server.authorized(o)) return _unauth();
      return jsonBody({
        'data': [
          for (final i in imports.values)
            {...i, 'lines': null}..remove('lines'),
        ],
      });
    });
    server.on('GET /api/v1/statements/imports/{id}', (o) {
      if (!server.authorized(o)) return _unauth();
      final imp = imports[o.uri.pathSegments[4]];
      return imp == null
          ? finetError(404, 'not_found', 'Nu există.')
          : jsonBody({'data': imp});
    });
    server.on('POST /api/v1/statements/uploads', _upload);
    server.on('GET /api/v1/statements/uploads/{id}', (o) {
      if (!server.authorized(o)) return _unauth();
      final polls = pdfPolls = pdfPolls + 1;
      return jsonBody({
        'data': {
          'id': pdfUpload,
          'accountId': FakeServer.accCurrent,
          'currency': 'RON',
          'status': polls < 2 ? 'processing' : 'parsed',
          'errorCode': null,
          'importId': polls < 2 ? null : importId,
          'partIndex': 0,
          'sizeBytes': 10,
          'createdAt': '2026-11-01T10:00:00.000Z',
          'expiresAt': '2026-11-02T10:00:00.000Z',
          'fileDeleted': false,
        },
      });
    });
    server.on('POST /api/v1/statements/imports/{id}/confirm', (o) {
      if (!server.authorized(o)) return _unauth();
      final key = o.headers['Idempotency-Key'] as String?;
      if (key == null) return finetError(400, 'invalid_request', 'Cheie lipsă');
      final body = Map<String, Object?>.from(o.data as Map);
      confirmBodies.add(body);
      confirmKeys.add(key);
      final imp = imports[o.uri.pathSegments[4]]!;
      if (imp['balanceStatus'] == 'mismatch' &&
          body['acknowledgeBalanceMismatch'] != true) {
        return finetError(
          409,
          'statement_balance_mismatch',
          'Soldurile extrasului nu se potrivesc; confirmă explicit după verificare.',
        );
      }
      final fx = (body['fx'] as List?) ?? const [];
      final lines = imp['lines']! as List;
      for (final l in lines.cast<Map<String, Object?>>()) {
        if (l['kind'] == 'fx' &&
            !fx.any((f) => (f as Map)['rowNo'] == l['rowNo'])) {
          return finetError(
            400,
            'validation_failed',
            'Alege ce se întâmplă cu fiecare schimb valutar.',
          );
        }
      }
      imp['status'] = 'imported';
      imp['importedCount'] = 2;
      return jsonBody({'data': imp});
    });
    server.on('DELETE /api/v1/statements/imports/{id}', (o) {
      if (!server.authorized(o)) return _unauth();
      discarded.add(o.uri.pathSegments[4]);
      imports.remove(o.uri.pathSegments[4]);
      return emptyBody(204);
    });
    server.on('POST /api/v1/statements/imports/{id}/cancel', (o) {
      if (!server.authorized(o)) return _unauth();
      cancelled.add(o.uri.pathSegments[4]);
      return jsonBody({'data': imports[o.uri.pathSegments[4]]});
    });
  }

  final FakeServer server;

  static const importId = '55000000-0000-4000-8000-000000000001';
  static const pdfUpload = '66000000-0000-4000-8000-000000000001';

  /// Rezultatul următoarei încărcări: `preview`, `queued`, `mapping_required` sau `rejected`.
  String nextKind = 'preview';
  bool mismatch = false;
  bool withFx = false;
  int pdfPolls = 0;
  int uploadAttempts = 0;
  int failUploads = 0;
  final List<List<Part>> uploads = [];
  final List<Map<String, Object?>> confirmBodies = [];
  final List<String> confirmKeys = [];
  final List<String> discarded = [];
  final List<String> cancelled = [];
  final Map<String, Map<String, Object?>> imports = {};

  Map<String, Object?> _import() => {
    'id': importId,
    'accountId': FakeServer.accCurrent,
    'currency': 'RON',
    'bank': 'bt',
    'format': 'csv',
    'status': 'previewed',
    'periodStart': '2026-10-01',
    'periodEnd': '2026-10-31',
    'openingBalanceMinor': 100000,
    'closingBalanceMinor': 95000,
    'computedClosingMinor': mismatch ? 94000 : 95000,
    'balanceStatus': mismatch ? 'mismatch' : 'ok',
    'lineCount': withFx ? 3 : 2,
    'newCount': withFx ? 3 : 2,
    'duplicateCount': 0,
    'pendingCount': 0,
    'importedCount': 0,
    'warnings': <Object>[],
    'createdAt': '2026-11-01T10:00:00.000Z',
    'importedAt': null,
    'cancelledAt': null,
    'lines': [
      _line(1, 'Plată POS Kaufland', 'debit', 12000),
      _line(2, 'Salariu', 'credit', 700000),
      if (withFx) _line(3, 'Schimb valutar EUR', 'debit', 50000, fx: true),
    ],
  };

  Map<String, Object?> _line(
    int row,
    String description,
    String direction,
    int amount, {
    bool fx = false,
  }) => {
    'rowNo': row,
    'occurredOn': '2026-10-1$row',
    'direction': direction,
    'amountMinor': amount,
    'description': description,
    'bankReference': null,
    'kind': fx ? 'fx' : 'movement',
    'fxAmountMinor': fx ? 10000 : null,
    'fxCurrency': fx ? 'EUR' : null,
    'balanceAfterMinor': null,
    'state': 'new',
    'transactionId': null,
  };

  ResponseBody _upload(RequestOptions o) {
    if (!server.authorized(o)) return _unauth();
    uploadAttempts++;
    if (failUploads > 0) {
      failUploads--;
      throw DioException(
        requestOptions: o,
        type: DioExceptionType.connectionError,
      );
    }
    uploads.add(
      parseMultipart(server.multipartBodies.last, o.contentType ?? ''),
    );
    Map<String, Object?> part;
    switch (nextKind) {
      case 'queued':
        pdfPolls = 0;
        imports[importId] = _import();
        part = {
          'index': 0,
          'kind': 'queued',
          'upload': {
            'id': pdfUpload,
            'accountId': FakeServer.accCurrent,
            'currency': 'RON',
            'status': 'queued',
            'errorCode': null,
            'importId': null,
            'partIndex': 0,
            'sizeBytes': 10,
            'createdAt': '2026-11-01T10:00:00.000Z',
            'expiresAt': '2026-11-02T10:00:00.000Z',
            'fileDeleted': false,
          },
          'duplicate': false,
        };
      case 'mapping_required':
        part = {
          'index': 0,
          'kind': 'mapping_required',
          'format': 'csv',
          'columnCount': 4,
          'rowCount': 10,
          'sample': <Object>[],
          'suggestion': {
            'mapping': <String, Object?>{},
            'missing': <Object>[],
            'template': null,
          },
        };
      case 'rejected':
        part = {'index': 0, 'kind': 'rejected', 'code': 'zip_unsafe'};
      default:
        imports[importId] = _import();
        part = {
          'index': 0,
          'kind': 'preview',
          'import': imports[importId],
          'alreadyImported': false,
          'balanceReasons': <Object>[],
        };
    }
    return jsonBody({
      'data': {
        'parts': [part],
      },
    }, status: 201);
  }

  ResponseBody _unauth() =>
      finetError(401, 'unauthenticated', 'Sesiune invalidă');
}
