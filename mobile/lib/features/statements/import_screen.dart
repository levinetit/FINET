import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/network/api_error.dart';
import '../../core/providers.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../finance/models.dart';
import '../finance/providers.dart';
import '../receipts/receipts_api.dart';
import '../receipts/strings.dart';
import '../scan/media.dart';
import '../scan/providers.dart';
import 'models.dart';
import 'providers.dart';

/// Importul unui extras: alegi contul și fișierul (PDF, CSV sau XLSX) sau vii din „Partajează”.
/// Serverul recunoaște banca și face previzualizarea; PDF-urile sunt citite de worker, deci
/// ecranul urmărește starea până la previzualizare.
class StatementImportScreen extends ConsumerStatefulWidget {
  const StatementImportScreen({super.key, this.shared});

  /// Fișierul primit prin „Partajează”, dacă există.
  final PickedMedia? shared;

  @override
  ConsumerState<StatementImportScreen> createState() =>
      _StatementImportScreenState();
}

class _StatementImportScreenState extends ConsumerState<StatementImportScreen> {
  PickedMedia? _file;
  String? _accountId;
  bool _busy = false;
  String? _message;
  String? _pendingUpload;

  /// Octeții pregătiți: la reîncercare se trimit aceiași.
  UploadFile? _prepared;

  @override
  void initState() {
    super.initState();
    _file = widget.shared;
  }

  Future<void> _pick() async {
    final file = await ref
        .read(mediaPickerProvider)
        .pickDocument(extensions: const ['pdf', 'csv', 'xlsx']);
    if (file == null) return;
    setState(() {
      _file = file;
      _prepared = null;
      _message = null;
    });
  }

  Future<void> _upload() async {
    final file = _file;
    final accountId = _accountId;
    if (_busy || file == null || accountId == null) return;
    if (file.kind != MediaKind.pdf &&
        file.kind != MediaKind.csv &&
        file.kind != MediaKind.spreadsheet) {
      setState(() => _message = 'Se acceptă PDF, CSV sau XLSX pentru extrase.');
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final prepared = _prepared ??= await ref
          .read(mediaNormalizerProvider)
          .normalize(file);
      final parts = await ref
          .read(statementsApiProvider)
          .upload(accountId, prepared);
      await ref.read(tempFilesProvider).delete([file.path]);
      if (!mounted) return;
      _handle(parts.isEmpty ? null : parts.first);
    } on ApiError catch (e) {
      ref.read(usageTrackerProvider).error(e);
      if (mounted) {
        setState(
          () => _message = statementErrorText[e.code] ?? uploadErrorText(e),
        );
      }
    } on FormatException catch (e) {
      if (mounted) setState(() => _message = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _handle(UploadPart? part) {
    switch (part) {
      case PreviewPart(:final import):
        context.pushReplacement('/statements/${import.id}');
      case QueuedPart(:final upload):
        setState(() => _pendingUpload = upload.id);
      case MappingRequiredPart():
        setState(
          () => _message =
              'Fișierul cere asocierea coloanelor (data, suma, descrierea). '
              'Fă-o din aplicația web FINET, apoi importul se poate relua.',
        );
      case RejectedPart(:final code):
        setState(
          () => _message = statementErrorText[code] ?? documentErrorText(code),
        );
      case null:
        setState(() => _message = 'Serverul nu a întors niciun rezultat.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final accounts = ref.watch(accountsProvider).asData?.value.accounts;
    final eligible = [
      for (final a in accounts ?? const <Account>[])
        if (!a.archived) a,
    ];
    final c = context.finet;
    final pending = _pendingUpload;
    if (pending != null) {
      ref.listen(statementUploadProvider(pending), (_, next) {
        final upload = next.asData?.value;
        if (upload == null || upload.inFlight) return;
        if (upload.importId != null) {
          context.pushReplacement('/statements/${upload.importId}');
        } else {
          setState(() {
            _pendingUpload = null;
            _message =
                statementErrorText[upload.errorCode] ??
                documentErrorText(upload.errorCode);
          });
        }
      });
    }
    return FinetScaffold(
      title: 'Importă un extras',
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            'Alege contul și fișierul extrasului (PDF, CSV sau XLSX). Serverul FINET îl citește '
            'și îți arată o previzualizare; nimic nu se salvează până nu confirmi.',
          ),
          const SizedBox(height: 16),
          DropdownButtonFormField<String>(
            isExpanded: true,
            initialValue: _accountId,
            decoration: const InputDecoration(labelText: 'Contul'),
            items: [
              for (final a in eligible)
                DropdownMenuItem(
                  value: a.id,
                  child: Text('${a.name} (${a.currency.code})'),
                ),
            ],
            onChanged: _busy ? null : (v) => setState(() => _accountId = v),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: _busy ? null : _pick,
            icon: const Icon(Icons.attach_file),
            label: Text(_file == null ? 'Alege fișierul' : _file!.name),
          ),
          if (_message != null)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: Text(_message!, style: TextStyle(color: c.bad)),
            ),
          const SizedBox(height: 16),
          if (pending != null)
            const Row(
              children: [
                SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                SizedBox(width: 12),
                Expanded(child: Text('Se citește extrasul…')),
              ],
            )
          else
            FilledButton(
              onPressed: _busy || _file == null || _accountId == null
                  ? null
                  : _upload,
              child: Text(_busy ? 'Se încarcă…' : 'Încarcă extrasul'),
            ),
        ],
      ),
    );
  }
}
