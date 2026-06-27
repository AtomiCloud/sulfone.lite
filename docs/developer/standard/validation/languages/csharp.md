# Validation in C#/.NET

## Library: FluentValidation

FluentValidation provides a fluent interface for building strongly-typed validation rules.

```bash
dotnet add package FluentValidation
```

```csharp
using FluentValidation;
```

## Validator Classes

### Basic Validator

```csharp
public class UserValidator : AbstractValidator<User>
{
    public UserValidator()
    {
        RuleFor(x => x.Name)
            .NotEmpty().WithMessage("Name is required")
            .Length(2, 100).WithMessage("Name must be between 2 and 100 characters");

        RuleFor(x => x.Email)
            .NotEmpty().WithMessage("Email is required")
            .EmailAddress().WithMessage("Invalid email format");

        RuleFor(x => x.Age)
            .GreaterThanOrEqualTo(0).WithMessage("Age must be non-negative")
            .LessThan(150).WithMessage("Age must be less than 150");
    }
}
```

### Usage

```csharp
var validator = new UserValidator();
var result = validator.Validate(user);

if (!result.IsValid)
{
    foreach (var error in result.Errors)
    {
        Console.WriteLine($"{error.PropertyName}: {error.ErrorMessage}");
    }
}
```

## Built-In Validators

### String Validators

```csharp
RuleFor(x => x.Name)
    .NotEmpty()           // not null, empty, or whitespace
    .NotNull()            // not null
    .Length(2, 100)       // between 2 and 100 chars
    .MinimumLength(2)     // at least 2 chars
    .MaximumLength(100)   // at most 100 chars
    .Matches(@"^\d{5}$")  // regex match
    .EmailAddress()       // email format
    .CreditCard()         // credit card format
    .Url();               // URL format
```

### Number Validators

```csharp
RuleFor(x => x.Age)
    .GreaterThanOrEqualTo(0)
    .GreaterThan(17)
    .LessThanOrEqualTo(150)
    .LessThan(200)
    .ExclusiveBetween(0, 100)
    .InclusiveBetween(0, 100)
    .PrecisionScale(5, 2, false); // max 5 digits, 2 decimal places
```

### Collection Validators

```csharp
RuleFor(x => x.Tags)
    .NotEmpty().WithMessage("At least one tag required")
    .Must(tags => tags.Count <= 10).WithMessage("Maximum 10 tags allowed");

// Validate each element
RuleForEach(x => x.Items)
    .SetValidator(new ItemValidator());
```

### Enum Validators

```csharp
RuleFor(x => x.Status)
    .IsInEnum().WithMessage("Invalid status value");
```

## Complex Rules

### When/Unless (Conditional)

```csharp
RuleFor(x => x.CompanyName)
    .NotEmpty().When(x => x.IsEmployee)
    .NotEmpty().Unless(x => x.IsFreelancer);

RuleFor(x => x.Discount)
    .GreaterThanOrEqualTo(0).When(x => x.ApplyDiscount);
```

### Dependent Rules

```csharp
RuleFor(x => x.Password)
    .NotEmpty().WithMessage("Password is required")
    .Equal(x => x.ConfirmPassword).WithMessage("Passwords must match")
    .When(x => !string.IsNullOrEmpty(x.Password));
```

### Must (Custom Predicate)

```csharp
RuleFor(x => x.StartDate)
    .Must((model, startDate) => startDate < model.EndDate)
    .WithMessage("Start date must be before end date");

RuleFor(x => x.PostalCode)
    .Must(BeValidPostalCode).WithMessage("Invalid postal code");

private bool BeValidPostalCode(string postalCode)
{
    // Custom validation logic
    return Regex.IsMatch(postalCode ?? "", @"^\d{5}(-\d{4})?$");
}
```

### Custom Validators

```csharp
public class PostalCodeValidator<T> : PropertyValidator<T, string>
{
    public override string Name => "PostalCodeValidator";

    public override bool IsValid(ValidationContext<T> context, string value)
    {
        if (string.IsNullOrEmpty(value)) return true; // Let NotEmpty handle null

        return Regex.IsMatch(value, @"^\d{5}(-\d{4})?$");
    }

    protected override string GetDefaultMessageTemplate(string errorCode)
        => "Invalid postal code format";
}

// Usage
RuleFor(x => x.PostalCode)
    .SetValidator(new PostalCodeValidator<User>());
```

## Async Validation

```csharp
public class UserValidator : AbstractValidator<User>
{
    private readonly IUserRepository _repo;

    public UserValidator(IUserRepository repo)
    {
        _repo = repo;

        RuleFor(x => x.Email)
            .MustAsync(BeUniqueEmail).WithMessage("Email already registered");
    }

    private async Task<bool> BeUniqueEmail(string email, CancellationToken ct)
    {
        var exists = await _repo.EmailExistsAsync(email, ct);
        return !exists;
    }
}

// Usage
var result = await validator.ValidateAsync(user);
```

## Child Validators

```csharp
public class AddressValidator : AbstractValidator<Address>
{
    public AddressValidator()
    {
        RuleFor(x => x.Street).NotEmpty();
        RuleFor(x => x.City).NotEmpty();
        RuleFor(x => x.PostalCode).Matches(@"^\d{5}$");
    }
}

public class UserValidator : AbstractValidator<User>
{
    public UserValidator()
    {
        RuleFor(x => x.Name).NotEmpty();
        RuleFor(x => x.Address).SetValidator(new AddressValidator());
    }
}
```

## Error Messages

### Custom Messages

```csharp
RuleFor(x => x.Name)
    .NotEmpty().WithMessage("Name is required")
    .Length(2, 100).WithMessage("Name must be between {MinLength} and {MaxLength} characters");
    // Placeholders: {PropertyName}, {PropertyValue}, {MinLength}, {MaxLength}, etc.
```

### Error Severity

```csharp
RuleFor(x => x.Name)
    .NotEmpty().WithSeverity(Severity.Error)
    .Length(2, 100).WithSeverity(Severity.Warning);
```

### Override Property Name

```csharp
RuleFor(x => x.PostalCode)
    .NotEmpty().WithName("ZIP Code")
    .Matches(@"^\d{5}$").WithMessage("{PropertyName} must be 5 digits");
```

## Integration Patterns

### ASP.NET Core Integration

```csharp
// Program.cs
builder.Services.AddValidatorsFromAssemblyContaining<Program>();

// Controller
public class UsersController : ControllerBase
{
    private readonly IValidator<CreateUserRequest> _validator;

    public UsersController(IValidator<CreateUserRequest> validator)
    {
        _validator = validator;
    }

    [HttpPost]
    public async Task<IActionResult> Create([FromBody] CreateUserRequest request)
    {
        var result = await _validator.ValidateAsync(request);

        if (!result.IsValid)
        {
            return BadRequest(new
            {
                Errors = result.Errors.Select(e => new
                {
                    Field = e.PropertyName,
                    Message = e.ErrorMessage
                })
            });
        }

        // Process valid request
        return Ok();
    }
}
```

### Automatic Validation Filter

```csharp
// Program.cs
builder.Services.AddFluentValidationAutoValidation();

// Controller - validation happens automatically
[HttpPost]
public IActionResult Create([FromBody] CreateUserRequest request)
{
    // Only reached if validation passes
    return Ok();
}
```

### Result Pattern Integration

```csharp
public static class ValidationResultExtensions
{
    public static Result<T> ToResult<T>(this ValidationResult result, T value)
    {
        if (result.IsValid)
            return Result.Ok(value);

        var errors = result.Errors
            .GroupBy(e => e.PropertyName)
            .ToDictionary(g => g.Key, g => g.Select(e => e.ErrorMessage).ToArray());

        return Result.Fail<T>(new ValidationError(errors));
    }
}

// Usage
var result = await _validator.ValidateAsync(request);
return result.ToResult(request);
```
