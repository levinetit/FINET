import 'dart:convert';

import 'package:dio/dio.dart';

import 'fake_server.dart';
import 'multipart.dart';

/// Documente, bonuri și potriviri pe [FakeServer]. Serverul „citește” un bon la a doua
/// interogare a documentului (queued → processing → needs_review). Octeții identici dau același
/// document (`duplicate: true`), ca SHA-256 pe serverul real.
class FakeReceipts {
  FakeReceipts(this.server) {
    server.on('GET /api/v1/ai/usage', (o) {
      if (!server.authorized(o)) return _unauth();
      return jsonBody({
        'data': {'used': 3, 'limit': 50, 'remaining': 47},
      });
    });
    server.on('POST /api/v1/documents', _upload);
    server.on('GET /api/v1/documents/{id}', (o) {
      if (!server.authorized(o)) return _unauth();
      final id = o.uri.pathSegments[3];
      final doc = documents[id];
      if (doc == null) return finetError(404, 'not_found', 'Nu există.');
      final polls = docPolls[id] = (docPolls[id] ?? 0) + 1;
      if (consentRequired) {
        doc['status'] = 'awaiting_consent';
      } else if (doc['status'] != 'needs_review' && doc['status'] != 'done') {
        doc['status'] = polls == 1 ? 'processing' : 'needs_review';
        if (polls >= 2) doc['receiptId'] = receiptNew;
      }
      return jsonBody({'data': doc});
    });
    server.on('GET /api/v1/receipts', (o) {
      if (!server.authorized(o)) return _unauth();
      final status = o.uri.queryParameters['status'];
      final items = [
        for (final r in receipts.values)
          if (status == null || r['status'] == status) _publicReceipt(r),
      ];
      return jsonBody({'data': items, 'nextCursor': null});
    });
    server.on('GET /api/v1/receipts/{id}', (o) {
      final r = _receipt(o);
      return r == null ? _missing() : jsonBody({'data': _detail(r)});
    });
    server.on('PATCH /api/v1/receipts/{id}', (o) {
      final r = _receipt(o);
      if (r == null) return _missing();
      if (r['status'] == 'saved') {
        return finetError(409, 'receipt_saved', 'Bonul e salvat.');
      }
      final body = Map<String, Object?>.from(o.data as Map);
      patches.add(body);
      for (final key in const ['merchantName', 'occurredOn', 'totalMinor']) {
        if (body.containsKey(key)) r[key] = body[key];
      }
      final lines = body['lines'];
      if (lines is List) {
        var position = 0;
        r['lines'] = [
          for (final raw in lines)
            _withId(Map<String, Object?>.from(raw as Map), position++),
        ];
        // Serverul recalculează suma liniilor (reducerile scad).
        var sum = 0;
        for (final l in r['lines']! as List) {
          final m = l as Map;
          final amount = m['lineTotalMinor']! as int;
          sum += m['kind'] == 'discount' ? -amount : amount;
        }
        r['linesSumMinor'] = sum;
        r['lineCount'] = (r['lines']! as List).length;
      }
      return jsonBody({'data': _detail(r)});
    });
    server.on('DELETE /api/v1/receipts/{id}', (o) {
      final r = _receipt(o);
      if (r == null) return _missing();
      receipts.remove(r['id']);
      return emptyBody(204);
    });
    server.on('POST /api/v1/receipts/{id}/confirm', (o) {
      final r = _receipt(o);
      if (r == null) return _missing();
      final key = o.headers['Idempotency-Key'] as String?;
      if (key == null) return finetError(400, 'invalid_request', 'Cheie lipsă');
      confirmKeys.add(key);
      final body = Map<String, Object?>.from(o.data as Map);
      confirmBodies.add(body);
      if (_confirmReplay.containsKey(key)) {
        return jsonBody(jsonDecode(_confirmReplay[key]!), status: 201);
      }
      if (r['status'] == 'saved') {
        return finetError(
          409,
          'receipt_already_saved',
          'Bonul a fost deja salvat.',
        );
      }
      if (r['duplicateOfReceiptId'] != null && body['allowDuplicate'] != true) {
        return finetError(
          409,
          'possible_duplicate',
          'Bonul pare un duplicat; confirmă explicit.',
        );
      }
      r['status'] = 'saved';
      r['transactionId'] = 'b0000000-0000-4000-8000-00000000000${++created}';
      final response = {
        'data': {'receipt': _detail(r), 'transactionId': r['transactionId']},
      };
      _confirmReplay[key] = jsonEncode(response);
      return jsonBody(response, status: 201);
    });
    server.on('POST /api/v1/receipts/{id}/reprocess', (o) {
      final r = _receipt(o);
      if (r == null) return _missing();
      reprocessed.add(r['id']! as String);
      r['status'] = 'queued';
      return jsonBody({
        'data': {'documentIds': r['documentIds'], 'queued': 1},
      }, status: 202);
    });
    server.on('GET /api/v1/receipts/{id}/matches', (o) {
      final r = _receipt(o);
      if (r == null) return _missing();
      return jsonBody({'data': r['id'] == receiptNew ? _matches(r) : null});
    });
    server.on('POST /api/v1/receipts/{id}/matches', (o) {
      final r = _receipt(o);
      if (r == null) return _missing();
      final body = Map<String, Object?>.from(o.data as Map);
      matchDecisions.add(body);
      return jsonBody({
        'data': {
          'receiptId': r['id'],
          'transactionId': body['transactionId'],
          'decision': body['decision'],
          'removedTransactionId': body['decision'] == 'confirm'
              ? txDuplicate
              : null,
        },
      });
    });
    server.on('GET /api/v1/matches', (o) {
      if (!server.authorized(o)) return _unauth();
      return jsonBody({
        'data': [_matches(receipts[receiptNew]!)],
      });
    });
  }

  final FakeServer server;

  static const receiptNew = 'e1000000-0000-4000-8000-000000000001';
  static const receiptSaved = 'e1000000-0000-4000-8000-000000000002';
  static const receiptFailed = 'e1000000-0000-4000-8000-000000000003';
  static const txMatch = 'f2000000-0000-4000-8000-000000000001';
  static const txDuplicate = 'f2000000-0000-4000-8000-000000000009';

  /// Dacă e `true`, documentele rămân în `awaiting_consent` (fără acord pentru AI).
  bool consentRequired = false;

  /// Câte încărcări următoare cad cu eroare de rețea.
  int failUploads = 0;

  /// Răspunsul de eroare dat la încărcare (în loc de succes), dacă e setat.
  ResponseBody Function()? uploadError;

  /// Câte încercări de încărcare au ajuns la server (inclusiv cele picate).
  int uploadAttempts = 0;

  final Map<String, Map<String, Object?>> documents = {};
  final Map<String, int> docPolls = {};
  final Map<String, String> _byContent = {};
  final List<List<Part>> uploads = [];
  final List<Map<String, Object?>> patches = [];
  final List<String> confirmKeys = [];
  final List<Map<String, Object?>> confirmBodies = [];
  final List<Map<String, Object?>> matchDecisions = [];
  final List<String> reprocessed = [];
  final Map<String, String> _confirmReplay = {};
  int created = 0;
  int lineSeq = 0;
  int _docSeq = 0;

  late final Map<String, Map<String, Object?>> receipts = {
    receiptNew: _seedNew(),
    receiptSaved: _seedBase(receiptSaved, 'saved', 'Kaufland', 12000),
    receiptFailed: _seedBase(receiptFailed, 'failed', null, null),
  };

  Map<String, Object?> _seedBase(
    String id,
    String status,
    String? merchant,
    int? total,
  ) => {
    'id': id,
    'status': status,
    'documentIds': [id.replaceFirst('e1', 'd1')],
    'batchId': null,
    'merchantName': merchant,
    'merchantTaxId': null,
    'storeAddress': null,
    'receiptNumber': null,
    'occurredOn': merchant == null ? null : '2026-10-20',
    'paymentMethod': null,
    'totalMinor': total,
    'vatTotalMinor': null,
    'currency': 'RON',
    'confidence': null,
    'providerUsed': 'none',
    'fallbackReason': null,
    'transactionId': status == 'saved'
        ? 'b0000000-0000-4000-8000-000000000099'
        : null,
    'duplicateOfReceiptId': null,
    'issues': <Object>[],
    'linesSumMinor': null,
    'categoryIds': <Object>[],
    'lineCount': 0,
    'lines': <Object>[],
    'removedLines': <Object>[],
    'removedCount': 0,
    'suggestedOrder': null,
    'createdAt': '2026-10-20T10:00:00.000Z',
    'updatedAt': '2026-10-20T10:00:00.000Z',
  };

  Map<String, Object?> _seedNew() => {
    ..._seedBase(receiptNew, 'needs_review', 'Mega Image', 4567),
    'documentIds': ['d9000000-0000-4000-8000-000000000001'],
    'merchantTaxId': null,
    'providerUsed': 'external',
    'fallbackReason': 'local_timeout',
    'confidence': 82,
    'issues': [
      {'code': 'tax_id_missing', 'field': 'taxId'},
      {'code': 'line_amount_mismatch', 'line': 2},
    ],
    'linesSumMinor': 4567,
    'lineCount': 3,
    'lines': [
      _line('l1', 0, 'Lapte 1L', 1500, quantity: '2', unit: 750, vat: '11'),
      _line('l2', 1, 'Pâine', 700, quantity: '1', unit: 600, vat: '11'),
      _line('l3', 2, 'Cafea', 2367, vat: '21'),
    ],
  };

  Map<String, Object?> _line(
    String id,
    int position,
    String name,
    int total, {
    String? quantity,
    int? unit,
    String? vat,
    String kind = 'product',
  }) => {
    'id': id,
    'position': position,
    'rawName': name,
    'normalizedName': null,
    'quantity': quantity,
    'unitPriceMinor': unit,
    'lineTotalMinor': total,
    'vatRate': vat,
    'categoryId': null,
    'kind': kind,
  };

  Map<String, Object?> _withId(Map<String, Object?> line, int position) => {
    ...line,
    'id': line['id'] ?? 'l${++lineSeq}',
    'position': position,
    'normalizedName': null,
  };

  Map<String, Object?> _detail(Map<String, Object?> r) => {...r};

  Map<String, Object?> _publicReceipt(Map<String, Object?> r) {
    final copy = {...r}
      ..remove('lines')
      ..remove('removedLines')
      ..remove('removedCount')
      ..remove('suggestedOrder');
    return copy;
  }

  Map<String, Object?> _matches(Map<String, Object?> r) => {
    'receiptId': r['id'],
    'status': r['status'],
    'merchantName': r['merchantName'],
    'occurredOn': '2026-10-20',
    'totalMinor': r['totalMinor'],
    'currency': 'RON',
    'ambiguous': false,
    'candidates': [
      {
        'transactionId': txMatch,
        'accountId': FakeServer.accCurrent,
        'occurredOn': '2026-10-21',
        'amountMinor': 4567,
        'currency': 'RON',
        'description': 'POS MEGA IMAGE 123',
        'score': 88,
        'probable': true,
        'reasons': ['amount_exact', 'date_diff_1', 'merchant_name'],
      },
    ],
  };

  Map<String, Object?>? _receipt(RequestOptions o) {
    if (!server.authorized(o)) return null;
    return receipts[o.uri.pathSegments[3]];
  }

  ResponseBody _missing() => finetError(404, 'not_found', 'Nu există.');

  ResponseBody _unauth() =>
      finetError(401, 'unauthenticated', 'Sesiune invalidă');

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
    final err = uploadError;
    if (err != null) return err();
    final parts = parseMultipart(
      server.multipartBodies.last,
      o.contentType ?? '',
    );
    uploads.add(parts);
    final docs = <Map<String, Object?>>[];
    var created = 0;
    for (final part in parts.where((p) => p.filename != null)) {
      final key = base64.encode(part.bytes);
      final existing = _byContent[key];
      if (existing != null) {
        docs.add({...documents[existing]!, 'duplicate': true});
        continue;
      }
      final id = 'd9000000-0000-4000-8000-00000000000${++_docSeq}';
      _byContent[key] = id;
      final doc = {
        'id': id,
        'kind': 'receipt',
        'status': 'queued',
        'mime': part.contentType ?? 'image/jpeg',
        'sizeBytes': part.bytes.length,
        'pages': null,
        'batchId': null,
        'documentOrder': null,
        'possibleDuplicateOfId': null,
        'errorCode': null,
        'createdAt': '2026-11-01T10:00:00.000Z',
        'expiresAt': null,
        'fileDeleted': false,
        'receiptId': null,
      };
      documents[id] = doc;
      docs.add({...doc, 'duplicate': false});
      created++;
    }
    return jsonBody({
      'data': {'documents': docs, 'batchId': null, 'created': created},
    }, status: created == 0 ? 200 : 201);
  }
}
