import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/providers.dart';
import '../scan/providers.dart';
import 'models.dart';
import 'statements_api.dart';

final statementsApiProvider = Provider<StatementsApi>(
  (ref) => StatementsApi(ref.watch(dioProvider)),
);

final coverageProvider = FutureProvider.autoDispose<List<AccountCoverage>>(
  (ref) => ref.watch(statementsApiProvider).coverage(),
);

final importsProvider = FutureProvider.autoDispose<List<StatementImport>>(
  (ref) => ref.watch(statementsApiProvider).imports(),
);

final importDetailProvider = FutureProvider.autoDispose
    .family<StatementImport, String>(
      (ref, id) => ref.watch(statementsApiProvider).importById(id),
    );

/// Starea citirii unui PDF de către worker, reinterogată cu pauze crescătoare până la o stare
/// finală (`parsed` sau `failed`). Se oprește și când ecranul se închide.
final statementUploadProvider = StreamProvider.autoDispose
    .family<StatementUpload, String>((ref, id) async* {
      final api = ref.watch(statementsApiProvider);
      final delay = ref.watch(pollDelayProvider);
      var attempt = 0;
      while (true) {
        final upload = await api.uploadStatus(id);
        yield upload;
        if (!upload.inFlight) return;
        await Future<void>.delayed(delay(attempt++));
      }
    });

/// Textul pentru codurile de eroare ale citirii extraselor, ca pe web.
const Map<String, String> statementErrorText = {
  'unknown_bank': 'Banca nu a fost recunoscută din fișier.',
  'multi_currency_statement': 'Extrasul conține mai multe monede.',
  'csv_invalid': 'Fișierul CSV nu poate fi citit.',
  'xlsx_unsafe': 'Fișierul XLSX nu este acceptat.',
  'zip_unsafe': 'Arhiva ZIP nu este acceptată.',
};
