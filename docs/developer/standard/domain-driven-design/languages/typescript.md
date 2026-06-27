# Domain-Driven Design in TypeScript/Bun

## Folder Structure

```
src/
  lib/                    # Pure domain code
    blog/                 # Bounded context
      post/
        structures.ts     # PostRecord, PostPrincipal, Post
        interfaces.ts     # IPostService, IPostRepository
        service.ts        # PostService implementation
        errors.ts         # PostNotFound, PostValidationError
      author/
        structures.ts
        interfaces.ts
        service.ts
    identity/             # Different bounded context
      user/
        structures.ts
        interfaces.ts
        service.ts
  adapters/               # Impure code
    repos/
    controllers/
```

## Record (Pure Data, No Identity)

```typescript
// src/lib/blog/post/structures.ts
interface PostRecord {
  title: string;
  description: string;
  tags: string[];
}

interface AuthorRecord {
  name: string;
  dateOfBirth: Date;
}
```

## Multiple Records per Entity

When an entity has fields with different update rates, split into multiple Records:

```typescript
// src/lib/identity/user/structures.ts

// Frequently changed by user
interface UserRecord {
  displayName: string;
  bio: string;
  avatarUrl: string;
}

// Locked at creation, never changes
interface UserImmutableRecord {
  email: string;
  createdAt: Date;
}

// Updated by external sync, infrequent
interface UserSyncRecord {
  stripeCustomerId: string;
  githubId: string;
  lastSyncAt: Date;
}
```

## Principal (Record + Identity)

**Single Record:**

```typescript
interface PostPrincipal {
  id: string;
  record: PostRecord;
}

interface AuthorPrincipal {
  id: string;
  record: AuthorRecord;
}
```

**Multiple Records:**

```typescript
interface UserPrincipal {
  id: string;
  record: UserRecord; // Mutable profile
  immutable: UserImmutableRecord; // Create-only
  sync: UserSyncRecord; // Externally synced
}
```

## Aggregate Root (Assembled View)

```typescript
interface Post {
  principal: PostPrincipal;
  author: AuthorPrincipal;
}

interface Author {
  principal: AuthorPrincipal;
  posts: PostPrincipal[];
}
```

## Service Interface (CRUD Blessed Path)

> Result type library to be determined. See error-handling skill for updates.

```typescript
// src/lib/blog/post/interfaces.ts
interface IPostService {
  search(params: PostSearch): Promise<PostPrincipal[]>;
  get(id: string): Promise<Post | null>;
  create(record: PostRecord): Promise<Post>;
  update(id: string, record: PostRecord): Promise<Post | null>;
  delete(id: string): Promise<void>;
}
```

## Repository Interface (Same Shape)

```typescript
interface IPostRepository {
  search(params: PostSearch): Promise<PostPrincipal[]>;
  get(id: string): Promise<Post | null>;
  create(record: PostRecord): Promise<Post>;
  update(id: string, record: PostRecord): Promise<Post | null>;
  delete(id: string): Promise<void>;
}
```

## Search Params

```typescript
interface PostSearch {
  titleContains?: string;
  tags?: string[];
  limit: number;
  offset: number;
}
```

## Domain Errors

```typescript
// src/lib/blog/post/errors.ts
class PostNotFound extends Error {
  constructor(readonly id: string) {
    super(`Post not found: ${id}`);
    this.name = 'PostNotFound';
  }
}

class PostValidationError extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`Invalid ${field}: ${reason}`);
    this.name = 'PostValidationError';
  }
}

type PostError = PostNotFound | PostValidationError;
```
