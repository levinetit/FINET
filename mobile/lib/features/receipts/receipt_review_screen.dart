import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:uuid/uuid.dart';

import '../../core/money/format.dart';
import '../../core/money/money.dart';
import '../../core/money/parse_amount.dart';
import '../../core/network/api_error.dart';
import '../../core/state/privacy.dart';
import '../../core/theme/tokens.dart';
import '../../core/time/period.dart';
import '../../core/widgets/amount_text.dart';
import '../../core/widgets/async_view.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../../core/providers.dart';
import '../auth/session.dart';
import '../finance/models.dart';
import '../lock/app_lock.dart';
import '../finance/providers.dart';
import '../scan/providers.dart';
import '../usage/usage_tracker.dart';
import 'match_panel.dart';
import 'models.dart';
import 'providers.dart';
import 'receipts_api.dart';
import 'strings.dart';

/// Verificarea unui bon: câmpurile și liniile citite de server, problemele găsite de verificările
/// serverului, corectarea liniilor și a categoriilor, confirmarea („Confirmă și salvează") și
/// potrivirea cu extrasul. Telefonul nu recalculează nimic: sumele liniilor și diferențele vin de
/// la server și se actualizează după „Salvează corecturile".
class ReceiptReviewScreen extends ConsumerWidget {
  const ReceiptReviewScreen({super.key, required this.receiptId});

  final String receiptId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(receiptDetailProvider(receiptId));
    return FinetScaffold(
      title: 'Bon',
      body: AsyncView<Receipt>(
        value: detail,
        onRetry: () => ref.invalidate(receiptDetailProvider(receiptId)),
        data: (receipt) =>
            _ReceiptForm(key: ValueKey(receipt.id), initial: receipt),
      ),
    );
  }
}

/// O linie în curs de editare. Cantitatea, prețul unitar și cota de TVA nu se editează aici, dar
/// se trimit înapoi neschimbate: `PATCH` înlocuiește liniile integral.
class _LineDraft {
  _LineDraft(ReceiptLine line, Currency currency)
    : id = line.id,
      quantity = line.quantity,
      unitPriceMinor = line.unitPriceMinor,
      vatRate = line.vatRate,
      name = TextEditingController(text: line.rawName),
      total = TextEditingController(
        text: editableAmount(Money(line.lineTotalMinor, currency)),
      ),
      categoryId = line.categoryId,
      kind = line.kind;

  _LineDraft.blank()
    : id = null,
      quantity = null,
      unitPriceMinor = null,
      vatRate = null,
      name = TextEditingController(),
      total = TextEditingController(),
      categoryId = null,
      kind = LineKind.product;

  final String? id;
  final String? quantity;
  final int? unitPriceMinor;
  final String? vatRate;
  final TextEditingController name;
  final TextEditingController total;
  String? categoryId;
  LineKind kind;

  void dispose() {
    name.dispose();
    total.dispose();
  }
}

class _ReceiptForm extends ConsumerStatefulWidget {
  const _ReceiptForm({super.key, required this.initial});

  final Receipt initial;

  @override
  ConsumerState<_ReceiptForm> createState() => _ReceiptFormState();
}

class _ReceiptFormState extends ConsumerState<_ReceiptForm> {
  late Receipt _receipt = widget.initial;
  late final TextEditingController _merchant;
  late final TextEditingController _total;
  late DateTime? _date;
  List<_LineDraft> _lines = [];
  bool _dirty = false;
  bool _busy = false;
  String? _error;
  String? _info;

  String? _accountId;
  String? _categoryId;
  String _confirmKey = const Uuid().v4();

  @override
  void initState() {
    super.initState();
    _merchant = TextEditingController();
    _total = TextEditingController();
    _load(_receipt);
  }

  /// Pune în câmpuri ce a întors serverul.
  void _load(Receipt r) {
    _merchant.text = r.merchantName ?? '';
    final total = r.total;
    _total.text = total == null ? '' : editableAmount(total);
    _date = r.occurredOn;
    for (final l in _lines) {
      l.dispose();
    }
    _lines = [for (final l in r.lines) _LineDraft(l, r.currency)];
    _dirty = false;
  }

  @override
  void dispose() {
    _merchant.dispose();
    _total.dispose();
    for (final l in _lines) {
      l.dispose();
    }
    super.dispose();
  }

  bool get _editable => _receipt.status == ReceiptStatus.needsReview;

  void _touch() => setState(() => _dirty = true);

  Future<void> _pickDate() async {
    final today = todayIn(
      ref.read(clockProvider)(),
      timezoneOf(ref.read(sessionProvider)),
    );
    final picked = await showDatePicker(
      context: context,
      initialDate: _date ?? today,
      firstDate: DateTime(today.year - 5, today.month, today.day),
      lastDate: today,
      locale: const Locale('ro', 'RO'),
    );
    if (picked != null) {
      setState(() => _date = picked);
      _touch();
    }
  }

  /// Corpul `PATCH`: sumele sunt `int` în unități minore, citite cu `parseAmount`.
  ReceiptPatch? _buildPatch() {
    final currency = _receipt.currency;
    int? totalMinor;
    final totalText = _total.text.trim();
    try {
      if (totalText.isNotEmpty) {
        totalMinor = parseAmount(totalText, currency).amountMinor;
      }
      final lines = <Map<String, Object?>>[];
      for (var i = 0; i < _lines.length; i++) {
        final l = _lines[i];
        final name = l.name.text.trim();
        if (name.isEmpty) {
          setState(() => _error = 'Linia ${i + 1} nu are denumire.');
          return null;
        }
        final amount = parseAmount(l.total.text, currency);
        lines.add({
          'id': ?l.id,
          'rawName': name,
          'quantity': l.quantity,
          'unitPriceMinor': l.unitPriceMinor,
          'lineTotalMinor': amount.amountMinor,
          'vatRate': l.vatRate,
          'categoryId': l.categoryId,
          'kind': l.kind.api,
        });
      }
      final merchant = _merchant.text.trim();
      return ReceiptPatch(
        setMerchantName: true,
        merchantName: merchant.isEmpty ? null : merchant,
        occurredOn: _date == null ? null : apiDate(_date!),
        totalMinor: totalMinor,
        lines: lines,
      );
    } on InvalidAmountException catch (e) {
      setState(() => _error = e.message);
      return null;
    }
  }

  Future<bool> _save() async {
    if (_busy) return false;
    final patch = _buildPatch();
    if (patch == null) return false;
    setState(() {
      _busy = true;
      _error = null;
      _info = null;
    });
    try {
      final saved = await ref
          .read(receiptsApiProvider)
          .patchReceipt(_receipt.id, patch);
      if (!mounted) return false;
      setState(() {
        _receipt = saved;
        _load(saved);
        _info = 'Corecturile au fost salvate; verificările au fost refăcute.';
      });
      ref.invalidate(receiptDetailProvider(_receipt.id));
      ref.invalidate(receiptMatchesProvider(_receipt.id));
      return true;
    } on ApiError catch (e) {
      ref.read(usageTrackerProvider).error(e);
      if (mounted) setState(() => _error = e.message);
      return false;
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _confirm({bool allowDuplicate = false}) async {
    final accountId = _accountId;
    if (_busy || accountId == null) return;
    setState(() {
      _busy = true;
      _error = null;
      _info = null;
    });
    try {
      final saved = await ref
          .read(receiptsApiProvider)
          .confirm(
            _receipt.id,
            accountId: accountId,
            categoryId: _categoryId,
            idempotencyKey: _confirmKey,
            allowDuplicate: allowDuplicate,
          );
      ref.read(usageTrackerProvider).track(UsageEvents.receiptConfirmed);
      invalidateFinance(ref.invalidate);
      ref.invalidate(receiptDetailProvider(_receipt.id));
      ref.invalidate(receiptMatchesProvider(_receipt.id));
      await ref.read(transactionsProvider.notifier).refresh();
      await ref.read(receiptsControllerProvider.notifier).refresh();
      if (!mounted) return;
      setState(() {
        _receipt = saved;
        _info = 'Bonul a fost salvat ca tranzacție.';
      });
    } on ApiError catch (e) {
      ref.read(usageTrackerProvider).error(e);
      if (!mounted) return;
      if (e.code == 'possible_duplicate') {
        // Acordul explicit al utilizatorului; alt corp, deci altă cheie de idempotență.
        _confirmKey = const Uuid().v4();
        setState(() => _busy = false);
        final again = await _askDuplicate();
        if (again) await _confirm(allowDuplicate: true);
        return;
      }
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<bool> _askDuplicate() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Posibil duplicat'),
        content: const Text(
          'Bonul pare un duplicat al unui bon salvat. Îl salvezi totuși ca o cumpărătură separată?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Nu'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Salvează oricum'),
          ),
        ],
      ),
    );
    return ok ?? false;
  }

  Future<void> _reprocess() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Citește din nou bonul?'),
        content: const Text(
          'Serverul îl citește încă o dată. Consumă din limita zilnică de documente.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Nu'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Citește din nou'),
          ),
        ],
      ),
    );
    if (ok != true || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref
          .read(receiptsApiProvider)
          .reprocess(_receipt.id, idempotencyKey: const Uuid().v4());
      if (!mounted) return;
      setState(() => _info = 'Bonul a fost pus din nou în coadă.');
      ref.invalidate(receiptDetailProvider(_receipt.id));
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Ștergi bonul?'),
        content: const Text(
          'Se șterg bonul și pozele lui. Tranzacția creată din el rămâne.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Nu'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Șterge'),
          ),
        ],
      ),
    );
    if (ok != true || _busy) return;
    setState(() => _busy = true);
    try {
      await ref.read(receiptsApiProvider).deleteReceipt(_receipt.id);
      await ref.read(receiptsControllerProvider.notifier).refresh();
      if (mounted) context.pop();
    } on ApiError catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final r = _receipt;
    final hidden = ref.watch(hideAmountsProvider);
    final c = context.finet;
    final accounts = ref.watch(accountsProvider).asData?.value.accounts;
    final matches = ref.watch(receiptMatchesProvider(r.id)).asData?.value;
    final categories = [
      for (final cat
          in ref.watch(categoriesProvider).asData?.value ?? const <Category>[])
        if (!cat.hidden) cat,
    ];
    final eligible = [
      for (final a in accounts ?? const <Account>[])
        if (!a.archived && a.currency == r.currency) a,
    ];
    _accountId ??= eligible.length == 1 ? eligible.first.id : null;
    final editable = _editable;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          '${r.status.label} · ${providerText(r.providerUsed)}',
          style: Theme.of(context).textTheme.titleSmall,
        ),
        if (fallbackText(r.fallbackReason) != null)
          Text(
            fallbackText(r.fallbackReason)!,
            style: TextStyle(color: c.muted),
          ),
        if (r.confidence != null)
          Text(
            'Scor de încredere: ${r.confidence} din 100 (calculat din verificări)',
            style: TextStyle(color: c.muted),
          ),
        if (r.duplicateOfReceiptId != null) ...[
          const SizedBox(height: 8),
          Card(
            color: c.warn.withValues(alpha: 0.12),
            child: ListTile(
              leading: Icon(Icons.copy_all_outlined, color: c.warn),
              title: const Text('Posibil duplicat al bonului'),
              subtitle: const Text('Deschide bonul original'),
              onTap: () => context.push('/receipts/${r.duplicateOfReceiptId}'),
            ),
          ),
        ],
        if (r.issues.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text(
            'Probleme găsite',
            style: Theme.of(context).textTheme.titleSmall,
          ),
          for (final issue in r.issues)
            Semantics(
              label: 'Problemă: ${issueText(issue)}',
              child: Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(Icons.warning_amber_rounded, size: 18, color: c.warn),
                    const SizedBox(width: 6),
                    Expanded(child: Text(issueText(issue))),
                  ],
                ),
              ),
            ),
        ] else if (r.status == ReceiptStatus.needsReview)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              'Verificările nu au găsit probleme.',
              style: TextStyle(color: c.muted),
            ),
          ),
        const SizedBox(height: 16),
        TextField(
          controller: _merchant,
          enabled: editable,
          decoration: const InputDecoration(labelText: 'Magazin'),
          onChanged: (_) => _touch(),
        ),
        const SizedBox(height: 12),
        InputDecorator(
          decoration: const InputDecoration(labelText: 'Data'),
          child: Row(
            children: [
              Expanded(
                child: Text(_date == null ? 'fără dată' : formatDate(_date!)),
              ),
              if (editable)
                TextButton(
                  onPressed: _pickDate,
                  child: const Text('Alege data'),
                ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _total,
          enabled: editable,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: InputDecoration(labelText: 'Total (${r.currency.code})'),
          onChanged: (_) => _touch(),
        ),
        if (r.paymentMethod != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text('Plata: ${r.paymentMethod!.label}'),
          ),
        const SizedBox(height: 16),
        Text(
          'Produsele de pe bon',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        if (r.linesSum != null && r.total != null)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              'Suma liniilor: ${displayMoney(r.linesSum!, hidden: hidden)} · '
              'Total bon: ${displayMoney(r.total!, hidden: hidden)}'
              '${_dirty ? ' (se actualizează după salvare)' : ''}',
              style: TextStyle(color: c.muted),
            ),
          ),
        if (r.removedCount > 0)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              '${r.removedCount} linii eliminate la unirea pozelor (suprapunere).',
              style: TextStyle(color: c.muted),
            ),
          ),
        for (var i = 0; i < _lines.length; i++)
          _LineEditor(
            key: ObjectKey(_lines[i]),
            draft: _lines[i],
            index: i,
            editable: editable,
            categories: categories,
            onChanged: _touch,
            onRemove: () {
              setState(() {
                _lines.removeAt(i).dispose();
                _dirty = true;
              });
            },
          ),
        if (editable)
          Align(
            alignment: Alignment.centerLeft,
            child: TextButton.icon(
              onPressed: () {
                setState(() {
                  _lines.add(_LineDraft.blank());
                  _dirty = true;
                });
              },
              icon: const Icon(Icons.add),
              label: const Text('Adaugă o linie'),
            ),
          ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(_error!, style: TextStyle(color: c.bad)),
          ),
        if (_info != null)
          Padding(padding: const EdgeInsets.only(top: 8), child: Text(_info!)),
        if (editable) ...[
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: _busy || !_dirty ? null : _save,
            child: const Text('Salvează corecturile'),
          ),
          const Divider(height: 32),
          if (eligible.isEmpty)
            Text(
              'Pentru a salva bonul ai nevoie de un cont deschis în ${r.currency.code}. '
              'Creează-l din aplicația web.',
            )
          else ...[
            DropdownButtonFormField<String>(
              initialValue: _accountId,
              decoration: const InputDecoration(labelText: 'Contul'),
              items: [
                for (final a in eligible)
                  DropdownMenuItem(value: a.id, child: Text(a.name)),
              ],
              onChanged: _busy
                  ? null
                  : (v) => setState(() {
                      _accountId = v;
                      _confirmKey = const Uuid().v4();
                    }),
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<String?>(
              initialValue: _categoryId,
              decoration: const InputDecoration(
                labelText: 'Categoria tranzacției',
                helperText:
                    'Lasă gol pentru categoria cu cea mai mare sumă de pe bon.',
              ),
              items: [
                const DropdownMenuItem<String?>(
                  value: null,
                  child: Text('Automată'),
                ),
                for (final cat in categories)
                  if (cat.kind == TxType.expense)
                    DropdownMenuItem<String?>(
                      value: cat.id,
                      child: Text(cat.name),
                    ),
              ],
              onChanged: _busy
                  ? null
                  : (v) => setState(() {
                      _categoryId = v;
                      _confirmKey = const Uuid().v4();
                    }),
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _busy || _dirty || _accountId == null
                  ? null
                  : _confirm,
              child: const Text('Confirmă și salvează'),
            ),
            if (_dirty)
              const Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text('Salvează întâi corecturile.'),
              ),
          ],
          const SizedBox(height: 8),
          TextButton(
            onPressed: _busy ? null : _reprocess,
            child: const Text('Citește din nou'),
          ),
        ],
        if (r.status == ReceiptStatus.saved)
          const Padding(
            padding: EdgeInsets.only(top: 12),
            child: Text('Bonul e salvat ca tranzacție; nu se mai modifică.'),
          ),
        if (r.status == ReceiptStatus.failed)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: TextButton(
              onPressed: _busy ? null : _reprocess,
              child: const Text('Citește din nou'),
            ),
          ),
        if (matches != null && matches.candidates.isNotEmpty) ...[
          const Divider(height: 32),
          MatchPanel(matches: matches),
        ],
        const SizedBox(height: 16),
        TextButton.icon(
          onPressed: _busy ? null : _delete,
          icon: Icon(Icons.delete_outline, color: c.bad),
          label: Text('Șterge bonul', style: TextStyle(color: c.bad)),
        ),
      ],
    );
  }
}

class _LineEditor extends StatelessWidget {
  const _LineEditor({
    super.key,
    required this.draft,
    required this.index,
    required this.editable,
    required this.categories,
    required this.onChanged,
    required this.onRemove,
  });

  final _LineDraft draft;
  final int index;
  final bool editable;
  final List<Category> categories;
  final VoidCallback onChanged;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final expense = [
      for (final c in categories)
        if (c.kind == TxType.expense) c,
    ];
    final known = expense.any((c) => c.id == draft.categoryId);
    return Card(
      margin: const EdgeInsets.only(top: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          children: [
            TextField(
              controller: draft.name,
              enabled: editable,
              decoration: InputDecoration(
                labelText: 'Denumire (linia ${index + 1})',
              ),
              onChanged: (_) => onChanged(),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: draft.total,
              enabled: editable,
              keyboardType: const TextInputType.numberWithOptions(
                decimal: true,
              ),
              decoration: const InputDecoration(labelText: 'Total linie'),
              onChanged: (_) => onChanged(),
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<LineKind>(
              initialValue: draft.kind,
              decoration: const InputDecoration(labelText: 'Tip'),
              items: [
                for (final k in LineKind.values)
                  DropdownMenuItem(value: k, child: Text(k.label)),
              ],
              onChanged: editable
                  ? (v) {
                      if (v != null) {
                        draft.kind = v;
                        onChanged();
                      }
                    }
                  : null,
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<String?>(
              initialValue: known ? draft.categoryId : null,
              decoration: const InputDecoration(labelText: 'Categorie'),
              items: [
                const DropdownMenuItem<String?>(
                  value: null,
                  child: Text('Necategorizat'),
                ),
                for (final c in expense)
                  DropdownMenuItem<String?>(value: c.id, child: Text(c.name)),
              ],
              onChanged: editable
                  ? (v) {
                      draft.categoryId = v;
                      onChanged();
                    }
                  : null,
            ),
            if (editable)
              Align(
                alignment: Alignment.centerRight,
                child: TextButton.icon(
                  onPressed: onRemove,
                  icon: const Icon(Icons.close),
                  label: const Text('Scoate linia'),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
