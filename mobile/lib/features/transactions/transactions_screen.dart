import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/money/format.dart';
import '../../core/network/api_error.dart';
import '../../core/providers.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/amount_text.dart';
import '../../core/widgets/finet_scaffold.dart';
import '../../core/widgets/states.dart';
import '../finance/models.dart';
import '../finance/providers.dart';
import 'transaction_filters_sheet.dart';

/// Tranzacții: lista paginată (cursor), căutare, filtre, adăugare, editare și ștergere cu
/// confirmare. Rândurile unui transfer sunt doar de citit.
class TransactionsScreen extends ConsumerStatefulWidget {
  const TransactionsScreen({super.key});

  @override
  ConsumerState<TransactionsScreen> createState() => _TransactionsScreenState();
}

class _TransactionsScreenState extends ConsumerState<TransactionsScreen> {
  final _scroll = ScrollController();
  final _search = TextEditingController();
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() {
      if (_scroll.position.extentAfter < 300) {
        unawaited(ref.read(transactionsProvider.notifier).loadMore());
      }
    });
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _scroll.dispose();
    _search.dispose();
    super.dispose();
  }

  void _onSearch(String text) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 400), () {
      final controller = ref.read(transactionsProvider.notifier);
      unawaited(
        controller.setFilters(
          ref.read(transactionsProvider).filters.copyWith(query: text),
        ),
      );
    });
  }

  Future<void> _openFilters() async {
    final filters = ref.read(transactionsProvider).filters;
    final result = await showModalBottomSheet<TransactionFilters>(
      context: context,
      isScrollControlled: true,
      builder: (_) => TransactionFiltersSheet(initial: filters),
    );
    if (result != null) {
      await ref
          .read(transactionsProvider.notifier)
          .setFilters(result.copyWith(query: filters.query));
    }
  }

  Future<void> _delete(FinTransaction t) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Ștergi tranzacția?'),
        content: Text('„${t.title}” va fi ștearsă definitiv.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Anulează'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Șterge'),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(financeApiProvider).deleteTransaction(t.id);
      invalidateFinance(ref.invalidate);
      await ref.read(transactionsProvider.notifier).refresh();
    } on ApiError catch (e) {
      ref.read(usageTrackerProvider).error(e);
      messenger.showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(transactionsProvider);
    final categories =
        ref.watch(categoriesProvider).asData?.value ?? const <Category>[];
    final names = {for (final c in categories) c.id: c.name};
    final text = Theme.of(context).textTheme;
    return FinetScaffold(
      title: 'Tranzacții',
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => context.push('/transactions/new'),
        icon: const Icon(Icons.add),
        label: const Text('Adaugă'),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _search,
                    onChanged: _onSearch,
                    textInputAction: TextInputAction.search,
                    decoration: const InputDecoration(
                      hintText: 'Caută',
                      prefixIcon: Icon(Icons.search),
                      border: OutlineInputBorder(),
                      isDense: true,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Badge(
                  isLabelVisible: state.filters.activeCount > 0,
                  label: Text('${state.filters.activeCount}'),
                  child: IconButton.outlined(
                    tooltip: 'Filtre',
                    icon: const Icon(Icons.filter_list),
                    onPressed: _openFilters,
                  ),
                ),
              ],
            ),
          ),
          Expanded(child: _body(state, names, text)),
        ],
      ),
    );
  }

  Widget _body(
    TransactionsState state,
    Map<String, String> names,
    TextTheme text,
  ) {
    if (state.loading && state.items.isEmpty) return const LoadingState();
    if (state.error != null && state.items.isEmpty) {
      return ErrorState(
        message: state.error!.message,
        onRetry: () => ref.read(transactionsProvider.notifier).refresh(),
      );
    }
    if (state.items.isEmpty) {
      final filtered = !state.filters.isEmpty;
      return EmptyState(
        title: filtered
            ? 'Nicio tranzacție pentru filtrele alese'
            : 'Nu ai încă tranzacții',
        message: filtered ? null : 'Adaugă prima tranzacție cu butonul de jos.',
        action: filtered
            ? OutlinedButton(
                onPressed: () {
                  _search.clear();
                  unawaited(
                    ref
                        .read(transactionsProvider.notifier)
                        .setFilters(const TransactionFilters()),
                  );
                },
                child: const Text('Șterge filtrele'),
              )
            : null,
      );
    }
    return RefreshIndicator(
      onRefresh: () => ref.read(transactionsProvider.notifier).refresh(),
      child: ListView.separated(
        controller: _scroll,
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
        itemCount:
            state.items.length +
            (state.hasMore || state.loadingMore || state.error != null ? 1 : 0),
        separatorBuilder: (_, _) => const Divider(),
        itemBuilder: (context, i) {
          if (i >= state.items.length) return _Footer(state: state);
          final t = state.items[i];
          return _TransactionTile(
            transaction: t,
            category: names[t.categoryId],
            onEdit: t.isTransfer
                ? null
                : () => context.push('/transactions/edit', extra: t),
            onDelete: t.isTransfer ? null : () => _delete(t),
          );
        },
      ),
    );
  }
}

class _Footer extends ConsumerWidget {
  const _Footer({required this.state});
  final TransactionsState state;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (state.error != null) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Text(state.error!.message),
            TextButton(
              onPressed: () =>
                  ref.read(transactionsProvider.notifier).loadMore(),
              child: const Text('Încearcă din nou'),
            ),
          ],
        ),
      );
    }
    return const Padding(
      padding: EdgeInsets.all(16),
      child: Center(
        child: SizedBox(
          height: 24,
          width: 24,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      ),
    );
  }
}

class _TransactionTile extends StatelessWidget {
  const _TransactionTile({
    required this.transaction,
    required this.category,
    required this.onEdit,
    required this.onDelete,
  });

  final FinTransaction transaction;
  final String? category;
  final VoidCallback? onEdit;
  final VoidCallback? onDelete;

  @override
  Widget build(BuildContext context) {
    final t = transaction;
    final text = Theme.of(context).textTheme;
    final subtitle = [
      if (t.isTransfer) 'Transfer' else ?category,
      formatDate(t.occurredOn),
      if (t.tags.isNotEmpty) t.tags.map((x) => x.name).join(', '),
    ].join(' · ');
    return InkWell(
      onTap: onEdit,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(t.title, style: text.bodyLarge),
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    style: text.bodySmall?.copyWith(color: context.finet.muted),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 12),
            AmountText(t.signed, signed: !t.isTransfer, bold: true),
            if (onDelete != null)
              PopupMenuButton<String>(
                tooltip: 'Mai multe',
                onSelected: (v) =>
                    v == 'edit' ? onEdit?.call() : onDelete?.call(),
                itemBuilder: (_) => const [
                  PopupMenuItem(value: 'edit', child: Text('Editează')),
                  PopupMenuItem(value: 'delete', child: Text('Șterge')),
                ],
              ),
          ],
        ),
      ),
    );
  }
}
