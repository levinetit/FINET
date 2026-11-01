import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:uuid/uuid.dart';

import '../../core/money/parse_amount.dart';
import '../../core/network/api_error.dart';
import '../../core/providers.dart';
import '../../core/time/period.dart';
import '../../core/widgets/async_view.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../../core/widgets/states.dart';
import '../auth/session.dart';
import '../finance/finance_api.dart';
import '../finance/models.dart';
import '../finance/providers.dart';
import '../lock/app_lock.dart';
import '../usage/usage_tracker.dart';

/// Formularul de tranzacție (creare sau editare): venit sau cheltuială, sumă, cont, dată,
/// categorie, descriere, comerciant, note, etichete. Suma se parsează cu aceleași reguli ca pe web
/// (`parseAmount`) și se trimite ca `amountMinor` întreg.
class TransactionFormScreen extends ConsumerWidget {
  const TransactionFormScreen({super.key, this.existing});

  /// `null` = tranzacție nouă.
  final FinTransaction? existing;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final accounts = ref.watch(accountsProvider);
    final categories = ref.watch(categoriesProvider);
    final tags = ref.watch(tagsProvider);
    final title = existing == null ? 'Tranzacție nouă' : 'Editează tranzacția';
    final loading =
        accounts.isLoading || categories.isLoading || tags.isLoading;
    final error = accounts.error ?? categories.error ?? tags.error;
    return FinetScaffold(
      title: title,
      screen: UsageScreens.transactionEdit,
      body: error != null
          ? ErrorState(
              message: errorMessage(error),
              onRetry: () => ref
                ..invalidate(accountsProvider)
                ..invalidate(categoriesProvider)
                ..invalidate(tagsProvider),
            )
          : loading
          ? const LoadingState()
          : _Form(
              existing: existing,
              accounts: accounts.requireValue.accounts
                  .where((a) => !a.archived || a.id == existing?.accountId)
                  .toList(),
              categories: categories.requireValue
                  .where((c) => !c.hidden || c.id == existing?.categoryId)
                  .toList(),
              tags: tags.requireValue.where((t) => !t.hidden).toList(),
            ),
    );
  }
}

class _Form extends ConsumerStatefulWidget {
  const _Form({
    required this.existing,
    required this.accounts,
    required this.categories,
    required this.tags,
  });

  final FinTransaction? existing;
  final List<Account> accounts;
  final List<Category> categories;
  final List<Tag> tags;

  @override
  ConsumerState<_Form> createState() => _FormState();
}

class _FormState extends ConsumerState<_Form> {
  final _formKey = GlobalKey<FormState>();
  late TxType _type = widget.existing?.type == TxType.income
      ? TxType.income
      : TxType.expense;
  late String? _accountId =
      widget.existing?.accountId ?? widget.accounts.firstOrNull?.id;
  String? _categoryId;
  late DateTime _date = widget.existing?.occurredOn ?? _today();
  late final Set<String> _tagIds = {...?widget.existing?.tags.map((t) => t.id)};
  late final _amount = TextEditingController(text: _initialAmount());
  late final _description = TextEditingController(
    text: widget.existing?.description ?? '',
  );
  late final _merchant = TextEditingController(
    text: widget.existing?.merchant ?? '',
  );
  late final _notes = TextEditingController(text: widget.existing?.notes ?? '');

  /// O singură cheie pe formular: apăsări repetate pe „Salvează” (sau reîncercări după o eroare de
  /// rețea) trimit aceeași cheie, deci serverul creează tranzacția o singură dată.
  final String _idempotencyKey = const Uuid().v4();
  bool _busy = false;
  ApiError? _error;

  @override
  void initState() {
    super.initState();
    final id = widget.existing?.categoryId;
    _categoryId = widget.categories.any((c) => c.id == id) ? id : null;
  }

  DateTime _today() =>
      todayIn(ref.read(clockProvider)(), timezoneOf(ref.read(sessionProvider)));

  String _initialAmount() {
    final e = widget.existing;
    if (e == null) return '';
    final whole = e.amountMinor ~/ 100;
    final cents = (e.amountMinor % 100).toString().padLeft(2, '0');
    return '$whole,$cents';
  }

  @override
  void dispose() {
    _amount.dispose();
    _description.dispose();
    _merchant.dispose();
    _notes.dispose();
    super.dispose();
  }

  Account? get _account =>
      widget.accounts.where((a) => a.id == _accountId).firstOrNull;

  String? _validateAmount(String? text) {
    final account = _account;
    if (account == null) return null;
    try {
      final money = parseAmount(text ?? '', account.currency);
      if (money.isZero) return 'Suma trebuie să fie mai mare ca zero.';
    } on InvalidAmountException catch (e) {
      return e.message;
    }
    return null;
  }

  Future<void> _save() async {
    if (_busy || !(_formKey.currentState?.validate() ?? false)) return;
    final account = _account;
    if (account == null) return;
    final draft = TransactionDraft(
      accountId: account.id,
      type: _type,
      amount: parseAmount(_amount.text, account.currency),
      occurredOn: _date,
      categoryId: _categoryId,
      description: _description.text,
      merchant: _merchant.text,
      notes: _notes.text,
      tagIds: _tagIds.toList(),
    );
    setState(() {
      _busy = true;
      _error = null;
    });
    final api = ref.read(financeApiProvider);
    try {
      final existing = widget.existing;
      if (existing == null) {
        await api.createTransaction(draft, idempotencyKey: _idempotencyKey);
        ref.read(usageTrackerProvider).track(UsageEvents.transactionCreated);
      } else {
        await api.updateTransaction(existing.id, draft);
      }
      invalidateFinance(ref.invalidate);
      await ref.read(transactionsProvider.notifier).refresh();
      if (mounted) context.pop();
    } on ApiError catch (e) {
      ref.read(usageTrackerProvider).error(e);
      if (mounted) setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _pickDate() async {
    final today = _today();
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(today.year - 5, today.month, today.day),
      lastDate: DateTime(today.year + 1, today.month, today.day),
      locale: const Locale('ro', 'RO'),
    );
    if (picked != null) setState(() => _date = picked);
  }

  @override
  Widget build(BuildContext context) {
    final categories = widget.categories.where((c) => c.kind == _type).toList();
    final error = _error;
    return Form(
      key: _formKey,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          if (error != null) ...[
            Semantics(
              liveRegion: true,
              child: Text(
                error.message,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ),
            const SizedBox(height: 12),
          ],
          SegmentedButton<TxType>(
            segments: const [
              ButtonSegment(value: TxType.expense, label: Text('Cheltuială')),
              ButtonSegment(value: TxType.income, label: Text('Venit')),
            ],
            selected: {_type},
            onSelectionChanged: _busy
                ? null
                : (s) => setState(() {
                    _type = s.first;
                    final stillValid = widget.categories.any(
                      (c) => c.id == _categoryId && c.kind == _type,
                    );
                    if (!stillValid) _categoryId = null;
                  }),
          ),
          const SizedBox(height: 16),
          TextFormField(
            controller: _amount,
            enabled: !_busy,
            keyboardType: const TextInputType.numberWithOptions(decimal: true),
            decoration: InputDecoration(
              labelText: 'Suma',
              suffixText: _account?.currency.symbol,
              border: const OutlineInputBorder(),
            ),
            validator: _validateAmount,
          ),
          const SizedBox(height: 16),
          DropdownButtonFormField<String>(
            isExpanded: true,
            initialValue: _accountId,
            decoration: const InputDecoration(
              labelText: 'Cont',
              border: OutlineInputBorder(),
            ),
            items: [
              for (final a in widget.accounts)
                DropdownMenuItem(
                  value: a.id,
                  child: Text('${a.name} (${a.currency.code})'),
                ),
            ],
            onChanged: _busy ? null : (v) => setState(() => _accountId = v),
            validator: (v) => v == null ? 'Alege un cont.' : null,
          ),
          const SizedBox(height: 16),
          InkWell(
            onTap: _busy ? null : _pickDate,
            child: InputDecorator(
              decoration: const InputDecoration(
                labelText: 'Data',
                border: OutlineInputBorder(),
              ),
              child: Text(apiDate(_date)),
            ),
          ),
          const SizedBox(height: 16),
          DropdownButtonFormField<String?>(
            isExpanded: true,
            key: ValueKey(_type),
            initialValue: _categoryId,
            decoration: const InputDecoration(
              labelText: 'Categorie',
              border: OutlineInputBorder(),
            ),
            items: [
              const DropdownMenuItem<String?>(child: Text('Fără categorie')),
              for (final c in categories)
                DropdownMenuItem<String?>(value: c.id, child: Text(c.name)),
            ],
            onChanged: _busy ? null : (v) => setState(() => _categoryId = v),
          ),
          const SizedBox(height: 16),
          TextFormField(
            controller: _description,
            enabled: !_busy,
            maxLength: 500,
            decoration: const InputDecoration(
              labelText: 'Descriere',
              border: OutlineInputBorder(),
            ),
          ),
          TextFormField(
            controller: _merchant,
            enabled: !_busy,
            maxLength: 200,
            decoration: const InputDecoration(
              labelText: 'Comerciant',
              border: OutlineInputBorder(),
            ),
          ),
          TextFormField(
            controller: _notes,
            enabled: !_busy,
            maxLines: 3,
            maxLength: 2000,
            decoration: const InputDecoration(
              labelText: 'Note',
              border: OutlineInputBorder(),
            ),
          ),
          if (widget.tags.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text('Etichete', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: [
                for (final t in widget.tags)
                  FilterChip(
                    label: Text(t.name),
                    selected: _tagIds.contains(t.id),
                    onSelected: _busy
                        ? null
                        : (on) => setState(
                            () => on ? _tagIds.add(t.id) : _tagIds.remove(t.id),
                          ),
                  ),
              ],
            ),
          ],
          const SizedBox(height: 24),
          FilledButton(
            onPressed: _busy ? null : _save,
            child: _busy
                ? const SizedBox(
                    height: 20,
                    width: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Salvează'),
          ),
        ],
      ),
    );
  }
}
