import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';

typedef RouteHandler = ResponseBody Function(RequestOptions options);

ResponseBody jsonBody(
  Object? body, {
  int status = 200,
  Map<String, List<String>>? headers,
}) {
  return ResponseBody.fromString(
    jsonEncode(body),
    status,
    headers: {
      Headers.contentTypeHeader: [Headers.jsonContentType],
      ...?headers,
    },
  );
}

ResponseBody emptyBody(int status) => ResponseBody.fromString('', status);

ResponseBody finetError(int status, String code, String message) => jsonBody({
  'error': {'code': code, 'message': message},
}, status: status);

/// Server FINET simulat: răspunde după „METODĂ /cale” și păstrează cererile primite. Nu face
/// rețea reală (promptul Android Faza B: backendul real de test cere un hostname de la operator).
class FakeServer implements HttpClientAdapter {
  FakeServer() {
    _standard();
    _finance();
  }

  static const email = 'ana@exemplu.ro';
  static const password = 'parola-fictiva-123';
  static const token = 'tokenFictiv.semnatura';

  final Map<String, RouteHandler> routes = {};
  final List<RequestOptions> requests = [];

  /// Dacă e `true`, orice cerere eșuează ca lipsă de rețea.
  bool offline = false;

  /// Dacă e `true`, rutele `/api/v1/*` răspund 401 (sesiune expirată/revocată).
  bool sessionRevoked = false;

  /// Gospodăria activă pe server (pentru `PUT /households/active`).
  String activeHousehold = hhOne;

  /// Consimțământul `usageStats` de pe server.
  bool usageStatsGranted = false;

  /// Loturile de evenimente primite (corpul `events`).
  final List<List<Map<String, Object?>>> eventBatches = [];

  static const hhOne = '11111111-1111-4111-8111-111111111111';
  static const hhTwo = '22222222-2222-4222-8222-222222222222';

  void on(String key, RouteHandler handler) => routes[key] = handler;

  Iterable<RequestOptions> requestsTo(String key) =>
      requests.where((r) => '${r.method} ${r.uri.path}' == key);

  bool get hasToken =>
      requests.any((r) => r.headers.containsKey('Authorization'));

  List<Map<String, Object?>> get allEvents => [
    for (final b in eventBatches) ...b,
  ];

  Map<String, Object?> _household(String id, String name, String role) => {
    'id': id,
    'name': name,
    'defaultCurrency': 'RON',
    'timezone': 'Europe/Bucharest',
    'role': role,
    'current': activeHousehold == id,
    'joinedAt': '2026-01-01T00:00:00.000Z',
  };

  bool _authorized(RequestOptions o) =>
      !sessionRevoked && o.headers['Authorization'] == 'Bearer $token';

  // ---- Date financiare simulate (Faza C) -------------------------------------------------------

  static const accCurrent = 'a0000000-0000-4000-8000-000000000001';
  static const accCash = 'a0000000-0000-4000-8000-000000000002';
  static const catFood = 'c0000000-0000-4000-8000-000000000001';
  static const catTransport = 'c0000000-0000-4000-8000-000000000002';
  static const catSalary = 'c0000000-0000-4000-8000-000000000003';
  static const tagFamily = 'e0000000-0000-4000-8000-000000000001';

  /// Tranzacțiile serverului, cele mai noi primele. 45 de rânduri, ca să existe mai multe pagini.
  late List<Map<String, Object?>> transactions = _seedTransactions();

  /// Răspunsurile memorate după `Idempotency-Key` (reluare = același răspuns, fără o a doua scriere).
  final Map<String, String> _replayBodies = {};

  /// Câte tranzacții a creat serverul (pentru teste de idempotență).
  int created = 0;

  /// Câte contribuții la obiectiv a aplicat serverul.
  int contributions = 0;

  /// Ultimul corp primit la `POST /api/v1/transactions`.
  Map<String, Object?>? lastCreateBody;

  /// Ultimul corp primit la `PATCH /api/v1/transactions/{id}`.
  Map<String, Object?>? lastPatchBody;

  /// Obiectivul (se modifică la contribuții).
  Map<String, Object?> goal = {
    'id': 'f1000000-0000-4000-8000-000000000001',
    'name': 'Vacanță',
    'targetMinor': 500000,
    'savedMinor': 150000,
    'currency': 'RON',
    'deadline': '2027-06-30',
    'status': 'active',
    'accountId': null,
    'progressPct': 30,
    'createdAt': '2026-01-01T00:00:00.000Z',
    'updatedAt': '2026-01-01T00:00:00.000Z',
  };

  /// Lunile cerute de aplicație la dashboard (`month=`).
  final List<String> dashboardMonths = [];

  static Map<String, Object?> _tx(
    int n, {
    required String type,
    required int amountMinor,
    required String date,
    String? description,
    String? merchant,
    String? categoryId,
    String accountId = accCurrent,
    List<Map<String, Object?>> tags = const [],
    String? transferGroupId,
  }) => {
    'id': 'f0000000-0000-4000-8000-${n.toString().padLeft(12, '0')}',
    'accountId': accountId,
    'categoryId': categoryId,
    'type': type,
    'amountMinor': amountMinor,
    'currency': 'RON',
    'occurredOn': date,
    'description': description,
    'merchant': merchant,
    'notes': null,
    'source': 'manual',
    'transferGroupId': transferGroupId,
    'transferDirection': transferGroupId == null ? null : 'out',
    'recurringRuleId': null,
    'documentId': null,
    'createdByUserId': 'u1',
    'createdAt': '2026-10-01T00:00:00.000Z',
    'updatedAt': '2026-10-01T00:00:00.000Z',
    'tags': tags,
  };

  static List<Map<String, Object?>> _seedTransactions() {
    final out = <Map<String, Object?>>[
      _tx(
        1,
        type: 'expense',
        amountMinor: 23480,
        date: '2026-10-31',
        description: 'Cumpărături săptămânale',
        merchant: 'Supermarket',
        categoryId: catFood,
        tags: [
          {'id': tagFamily, 'name': 'Familie', 'color': null},
        ],
      ),
      _tx(
        2,
        type: 'income',
        amountMinor: 780000,
        date: '2026-10-30',
        description: 'Salariu',
        categoryId: catSalary,
      ),
      _tx(
        3,
        type: 'transfer',
        amountMinor: 50000,
        date: '2026-10-29',
        description: 'Către numerar',
        transferGroupId: 'b0000000-0000-4000-8000-000000000001',
      ),
    ];
    for (var i = 4; i <= 45; i++) {
      final day = 28 - (i % 27);
      out.add(
        _tx(
          i,
          type: 'expense',
          amountMinor: 1000 + i * 37,
          date: '2026-10-${day.toString().padLeft(2, '0')}',
          description: 'Cheltuială $i',
          merchant: i.isEven ? 'Magazin Nord' : 'Magazin Sud',
          categoryId: i % 3 == 0 ? catTransport : catFood,
        ),
      );
    }
    return out;
  }

  ResponseBody _unauth() =>
      finetError(401, 'unauthenticated', 'Sesiune invalidă');

  static Map<String, Object?> _totals(int income, int expense, int count) => {
    'incomeMinor': income,
    'expenseMinor': expense,
    'netMinor': income - expense,
    'transactionCount': count,
  };

  void _finance() {
    on('GET /api/v1/dashboard', (o) {
      if (!_authorized(o)) return _unauth();
      final month = o.uri.queryParameters['month'] ?? '2026-11';
      dashboardMonths.add(month);
      return jsonBody({
        'data': {
          'month': month,
          'previousMonth': '2026-09',
          'onboarding': {
            'hasAccount': true,
            'hasTransaction': true,
            'hasBudget': true,
            'hasGoal': true,
            'steps': <Object>[],
            'completed': true,
          },
          'currencies': [
            {
              'currency': 'RON',
              'totals': _totals(780000, 512345, 37),
              'previous': _totals(700000, 600000, 30),
              'comparison': {
                'income': {'diffMinor': 80000, 'percent': 11},
                'expense': {'diffMinor': -87655, 'percent': -15},
                'net': {'diffMinor': 167655, 'percent': null},
              },
              'byCategory': [
                {
                  'categoryId': catFood,
                  'name': 'Alimente',
                  'isOther': false,
                  'amountMinor': 184500,
                  'percent': 36,
                },
                {
                  'categoryId': catTransport,
                  'name': 'Transport',
                  'isOther': false,
                  'amountMinor': 62345,
                  'percent': 12,
                },
                {
                  'categoryId': null,
                  'name': null,
                  'isOther': true,
                  'amountMinor': 265500,
                  'percent': 52,
                },
              ],
              'monthly': [
                {
                  'month': '2026-09',
                  'incomeMinor': 700000,
                  'expenseMinor': 600000,
                  'netMinor': 100000,
                },
                {
                  'month': '2026-10',
                  'incomeMinor': 780000,
                  'expenseMinor': 512345,
                  'netMinor': 267655,
                },
              ],
              'daily': <Object>[],
            },
          ],
        },
      });
    });
    on('GET /api/v1/accounts', (o) {
      if (!_authorized(o)) return _unauth();
      Map<String, Object?> acc(
        String id,
        String name,
        String type,
        int balance,
      ) => {
        'id': id,
        'name': name,
        'type': type,
        'currency': 'RON',
        'openingBalanceMinor': 0,
        'balanceMinor': balance,
        'bankCode': null,
        'ownerUserId': null,
        'archived': false,
        'archivedAt': null,
        'createdAt': '2026-01-01T00:00:00.000Z',
        'updatedAt': '2026-01-01T00:00:00.000Z',
      };
      return jsonBody({
        'data': [
          acc(accCurrent, 'Cont curent', 'bank', 123456),
          acc(accCash, 'Numerar', 'cash', 5000),
        ],
        'totals': [
          {'amountMinor': 128456, 'currency': 'RON'},
        ],
      });
    });
    on('GET /api/v1/categories', (o) {
      if (!_authorized(o)) return _unauth();
      Map<String, Object?> cat(String id, String name, String kind) => {
        'id': id,
        'name': name,
        'kind': kind,
        'parentId': null,
        'icon': null,
        'color': null,
        'hidden': false,
        'isSystem': true,
        'systemKey': null,
      };
      return jsonBody({
        'data': [
          cat(catFood, 'Alimente', 'expense'),
          cat(catTransport, 'Transport', 'expense'),
          cat(catSalary, 'Salariu', 'income'),
        ],
      });
    });
    on('GET /api/v1/tags', (o) {
      if (!_authorized(o)) return _unauth();
      return jsonBody({
        'data': [
          {
            'id': tagFamily,
            'name': 'Familie',
            'color': null,
            'hidden': false,
            'isSystem': false,
            'systemKey': null,
            'usageCount': 1,
          },
        ],
      });
    });
    on('GET /api/v1/transactions', (o) {
      if (!_authorized(o)) return _unauth();
      final q = o.uri.queryParameters;
      final rows = transactions.where((t) {
        if (q['type'] != null && t['type'] != q['type']) return false;
        if (q['accountId'] != null && t['accountId'] != q['accountId']) {
          return false;
        }
        if (q['categoryId'] != null && t['categoryId'] != q['categoryId']) {
          return false;
        }
        final date = t['occurredOn']! as String;
        if (q['dateFrom'] != null && date.compareTo(q['dateFrom']!) < 0) {
          return false;
        }
        if (q['dateTo'] != null && date.compareTo(q['dateTo']!) > 0) {
          return false;
        }
        final text = q['q']?.toLowerCase();
        if (text != null) {
          final hay = '${t['description'] ?? ''} ${t['merchant'] ?? ''}'
              .toLowerCase();
          if (!hay.contains(text)) return false;
        }
        return true;
      }).toList();
      final limit = int.parse(q['limit'] ?? '50');
      final start = int.parse(q['cursor'] ?? '0');
      final next = start + limit < rows.length ? '${start + limit}' : null;
      return jsonBody({
        'data': rows.skip(start).take(limit).toList(),
        'nextCursor': next,
      });
    });
    on('POST /api/v1/transactions', (o) {
      if (!_authorized(o)) return _unauth();
      final key = o.headers['Idempotency-Key'] as String?;
      if (key != null && _replayBodies.containsKey(key)) {
        return jsonBody(
          jsonDecode(_replayBodies[key]!),
          status: 201,
          headers: {
            'idempotent-replay': ['true'],
          },
        );
      }
      final body = Map<String, Object?>.from(o.data as Map);
      created++;
      final tx = _tx(
        1000 + created,
        type: body['type']! as String,
        amountMinor: body['amountMinor']! as int,
        date: body['occurredOn']! as String,
        description: body['description'] as String?,
        merchant: body['merchant'] as String?,
        categoryId: body['categoryId'] as String?,
        accountId: body['accountId']! as String,
      );
      transactions = [tx, ...transactions];
      lastCreateBody = body;
      if (key != null) _replayBodies[key] = jsonEncode({'data': tx});
      return jsonBody({'data': tx}, status: 201);
    });
    on('PATCH /api/v1/transactions/{id}', (o) {
      if (!_authorized(o)) return _unauth();
      final id = o.uri.pathSegments.last;
      final index = transactions.indexWhere((t) => t['id'] == id);
      if (index < 0) {
        return finetError(404, 'not_found', 'Resursa nu a fost găsită.');
      }
      final body = Map<String, Object?>.from(o.data as Map);
      lastPatchBody = body;
      final updated = {
        ...transactions[index],
        'type': body['type'],
        'amountMinor': body['amountMinor'],
        'occurredOn': body['occurredOn'],
        'categoryId': body['categoryId'],
        'description': body['description'],
        'merchant': body['merchant'],
        'accountId': body['accountId'],
      };
      transactions = [...transactions]..[index] = updated;
      return jsonBody({'data': updated});
    });
    on('DELETE /api/v1/transactions/{id}', (o) {
      if (!_authorized(o)) return _unauth();
      final id = o.uri.pathSegments.last;
      if (!transactions.any((t) => t['id'] == id)) {
        return finetError(404, 'not_found', 'Resursa nu a fost găsită.');
      }
      transactions = transactions.where((t) => t['id'] != id).toList();
      return emptyBody(204);
    });
    on('GET /api/v1/budgets/status', (o) {
      if (!_authorized(o)) return _unauth();
      final month = o.uri.queryParameters['month'] ?? '2026-10';
      Map<String, Object?> b(
        String id,
        String? cat,
        int amount,
        int spent,
        String status,
      ) => {
        'id': id,
        'categoryId': cat,
        'period': 'monthly',
        'amountMinor': amount,
        'currency': 'RON',
        'warnPct': 80,
        'scope': 'household',
        'userId': null,
        'archivedAt': null,
        'createdAt': '2026-01-01T00:00:00.000Z',
        'updatedAt': '2026-01-01T00:00:00.000Z',
        'month': month,
        'spentMinor': spent,
        'remainingMinor': amount - spent,
        'percent': spent * 100 ~/ amount,
        'status': status,
      };
      return jsonBody({
        'month': month,
        'data': [
          b(
            'bb000000-0000-4000-8000-000000000001',
            catTransport,
            100000,
            62345,
            'green',
          ),
          b(
            'bb000000-0000-4000-8000-000000000002',
            catFood,
            200000,
            184500,
            'yellow',
          ),
          b(
            'bb000000-0000-4000-8000-000000000003',
            null,
            450000,
            512345,
            'red',
          ),
        ],
        'alerts': <Object>[],
      });
    });
    on('GET /api/v1/goals', (o) {
      if (!_authorized(o)) return _unauth();
      return jsonBody({
        'data': [goal],
      });
    });
    on('POST /api/v1/goals/{id}/contributions', (o) {
      if (!_authorized(o)) return _unauth();
      final key = o.headers['Idempotency-Key'] as String?;
      if (key == null) {
        return jsonBody({
          'error': {
            'code': 'invalid_request',
            'message': 'Cheie lipsă',
            'fields': {'Idempotency-Key': 'Obligatorie'},
          },
        }, status: 400);
      }
      if (_replayBodies.containsKey(key)) {
        return jsonBody(
          jsonDecode(_replayBodies[key]!),
          headers: {
            'idempotent-replay': ['true'],
          },
        );
      }
      final body = Map<String, Object?>.from(o.data as Map);
      contributions++;
      final delta =
          (body['amountMinor']! as int) * (body['direction'] == 'add' ? 1 : -1);
      final saved = (goal['savedMinor']! as int) + delta;
      goal = {
        ...goal,
        'savedMinor': saved,
        'progressPct': saved * 100 ~/ (goal['targetMinor']! as int),
      };
      _replayBodies[key] = jsonEncode({'data': goal});
      return jsonBody({'data': goal});
    });
    on('GET /api/v1/reports/monthly', (o) {
      if (!_authorized(o)) return _unauth();
      return jsonBody({
        'data': {
          'month': o.uri.queryParameters['month'] ?? '2026-10',
          'currencies': [
            {
              'currency': 'RON',
              'totals': _totals(780000, 512345, 37),
              'byCategory': [
                {
                  'categoryId': catFood,
                  'name': 'Alimente',
                  'amountMinor': 184500,
                  'count': 12,
                  'percent': 36,
                  'children': <Object>[],
                },
              ],
              'topMerchants': [
                {'merchant': 'Supermarket', 'amountMinor': 98000, 'count': 5},
              ],
            },
          ],
          'budgets': <Object>[],
          'goals': <Object>[],
        },
      });
    });
  }

  void _standard() {
    on('POST /api/auth/sign-in/email', (o) {
      final body = o.data as Map;
      if (body['email'] == email && body['password'] == password) {
        return jsonBody(
          {
            'user': {'id': 'u1'},
          },
          headers: {
            'set-auth-token': [token],
          },
        );
      }
      return jsonBody({
        'code': 'INVALID_EMAIL_OR_PASSWORD',
        'message': 'Invalid email or password',
      }, status: 401);
    });
    on('POST /api/auth/sign-out', (o) => jsonBody({'success': true}));
    on('GET /api/v1/me', (o) {
      if (!_authorized(o)) {
        return finetError(401, 'unauthenticated', 'Sesiune invalidă');
      }
      final current = activeHousehold == hhOne
          ? ('Casa Ana', hhOne)
          : ('Casa de vacanță', hhTwo);
      return jsonBody({
        'data': {
          'user': {
            'id': 'u1',
            'email': email,
            'name': 'Ana Popescu',
            'emailVerified': true,
            'isPlatformAdmin': false,
            'createdAt': '2026-01-01T00:00:00.000Z',
          },
          'preferences': {
            'locale': 'ro',
            'timezone': 'Europe/Bucharest',
            'defaultCurrency': 'RON',
            'theme': 'system',
          },
          'household': {
            'id': current.$2,
            'name': current.$1,
            'defaultCurrency': 'RON',
            'timezone': 'Europe/Bucharest',
            'role': 'owner',
          },
        },
      });
    });
    on('GET /api/v1/households', (o) {
      if (!_authorized(o)) {
        return finetError(401, 'unauthenticated', 'Sesiune invalidă');
      }
      return jsonBody({
        'data': [
          _household(hhOne, 'Casa Ana', 'owner'),
          _household(hhTwo, 'Casa de vacanță', 'member'),
        ],
      });
    });
    on('PUT /api/v1/households/active', (o) {
      if (!_authorized(o)) {
        return finetError(401, 'unauthenticated', 'Sesiune invalidă');
      }
      activeHousehold = (o.data as Map)['householdId'] as String;
      return jsonBody({'data': _household(activeHousehold, 'x', 'owner')});
    });
    on('GET /api/v1/me/consents', (o) {
      if (!_authorized(o)) {
        return finetError(401, 'unauthenticated', 'Sesiune invalidă');
      }
      return jsonBody({
        'data': [
          {
            'kind': 'usageStats',
            'granted': usageStatsGranted,
            'grantedAt': null,
            'revokedAt': null,
          },
        ],
      });
    });
    on('PUT /api/v1/me/consents', (o) {
      if (!_authorized(o)) {
        return finetError(401, 'unauthenticated', 'Sesiune invalidă');
      }
      usageStatsGranted = (o.data as Map)['usageStats'] == true;
      return jsonBody({'data': <Object>[]});
    });
    on('POST /api/v1/app/events', (o) {
      if (!_authorized(o)) {
        return finetError(401, 'unauthenticated', 'Sesiune invalidă');
      }
      if (!usageStatsGranted) {
        return finetError(403, 'forbidden', 'Fără consimțământ');
      }
      final events = (o.data as Map)['events'] as List;
      eventBatches.add([
        for (final e in events) Map<String, Object?>.from(e as Map),
      ]);
      return emptyBody(204);
    });
  }

  /// Potrivește „METODĂ /cale”; `{id}` din șablon ia orice segment.
  RouteHandler? _match(RequestOptions o) {
    final call = '${o.method} ${o.uri.path}';
    final exact = routes[call];
    if (exact != null) return exact;
    for (final entry in routes.entries) {
      if (!entry.key.contains('{id}')) continue;
      final pattern = RegExp(
        '^${RegExp.escape(entry.key).replaceAll(r'\{id\}', '[^/]+')}\$',
      );
      if (pattern.hasMatch(call)) return entry.value;
    }
    return null;
  }

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    requests.add(options);
    if (offline) {
      throw DioException(
        requestOptions: options,
        type: DioExceptionType.connectionError,
      );
    }
    final handler = _match(options);
    if (handler == null) {
      return finetError(404, 'not_found', 'Resursa nu a fost găsită.');
    }
    return handler(options);
  }

  @override
  void close({bool force = false}) {}
}
