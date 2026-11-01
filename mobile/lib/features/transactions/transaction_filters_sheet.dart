import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/money/format.dart';
import '../finance/models.dart';
import '../finance/providers.dart';

/// Filtrele listei de tranzacții: tip, cont, categorie, perioadă. Întoarce filtrele alese (sau
/// `null` dacă se închide fără aplicare).
class TransactionFiltersSheet extends ConsumerStatefulWidget {
  const TransactionFiltersSheet({super.key, required this.initial});

  final TransactionFilters initial;

  @override
  ConsumerState<TransactionFiltersSheet> createState() =>
      _TransactionFiltersSheetState();
}

class _TransactionFiltersSheetState
    extends ConsumerState<TransactionFiltersSheet> {
  late TransactionFilters _f = widget.initial;

  Future<void> _pick({required bool from}) async {
    final today = DateTime.now();
    final initial = (from ? _f.dateFrom : _f.dateTo) ?? today;
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: DateTime(today.year - 6),
      lastDate: DateTime(today.year + 1, 12, 31),
      locale: const Locale('ro', 'RO'),
    );
    if (picked == null) return;
    setState(
      () => _f = from
          ? _f.copyWith(dateFrom: () => picked)
          : _f.copyWith(dateTo: () => picked),
    );
  }

  @override
  Widget build(BuildContext context) {
    final accounts =
        ref.watch(accountsProvider).asData?.value.accounts ?? const <Account>[];
    final categories =
        ref.watch(categoriesProvider).asData?.value ?? const <Category>[];
    final text = Theme.of(context).textTheme;
    return SafeArea(
      child: SingleChildScrollView(
        padding: EdgeInsets.fromLTRB(
          16,
          16,
          16,
          16 + MediaQuery.of(context).viewInsets.bottom,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Filtre', style: text.titleMedium),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              children: [
                ChoiceChip(
                  label: const Text('Toate'),
                  selected: _f.type == null,
                  onSelected: (_) =>
                      setState(() => _f = _f.copyWith(type: () => null)),
                ),
                for (final t in TxType.values)
                  ChoiceChip(
                    label: Text(t.label),
                    selected: _f.type == t,
                    onSelected: (_) =>
                        setState(() => _f = _f.copyWith(type: () => t)),
                  ),
              ],
            ),
            const SizedBox(height: 16),
            DropdownButtonFormField<String?>(
              isExpanded: true,
              initialValue: _f.accountId,
              decoration: const InputDecoration(
                labelText: 'Cont',
                border: OutlineInputBorder(),
              ),
              items: [
                const DropdownMenuItem<String?>(child: Text('Toate conturile')),
                for (final a in accounts)
                  DropdownMenuItem<String?>(value: a.id, child: Text(a.name)),
              ],
              onChanged: (v) =>
                  setState(() => _f = _f.copyWith(accountId: () => v)),
            ),
            const SizedBox(height: 16),
            DropdownButtonFormField<String?>(
              isExpanded: true,
              initialValue: _f.categoryId,
              decoration: const InputDecoration(
                labelText: 'Categorie',
                border: OutlineInputBorder(),
              ),
              items: [
                const DropdownMenuItem<String?>(
                  child: Text('Toate categoriile'),
                ),
                for (final c in categories)
                  DropdownMenuItem<String?>(value: c.id, child: Text(c.name)),
              ],
              onChanged: (v) =>
                  setState(() => _f = _f.copyWith(categoryId: () => v)),
            ),
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => _pick(from: true),
                    child: Text(
                      _f.dateFrom == null ? 'De la' : formatDate(_f.dateFrom!),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => _pick(from: false),
                    child: Text(
                      _f.dateTo == null ? 'Până la' : formatDate(_f.dateTo!),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 24),
            OverflowBar(
              alignment: MainAxisAlignment.spaceBetween,
              overflowAlignment: OverflowBarAlignment.end,
              children: [
                TextButton(
                  onPressed: () =>
                      Navigator.pop(context, const TransactionFilters()),
                  child: const Text('Șterge filtrele'),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(context, _f),
                  child: const Text('Aplică'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
