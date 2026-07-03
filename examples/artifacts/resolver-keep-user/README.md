# Keep User Resolver

Keeps the highest layer's variation when templates write the same path. Resolvers
run only while layering template output — user edits are handled by the git
three-way merge during `cyanprint update`, never by resolvers — so this resolver
simply picks the most recent layer's content.
