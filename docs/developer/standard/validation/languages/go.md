# Validation in Go

## Library: go-playground/validator

Struct tag-based validation with 60+ built-in validators.

```bash
go get github.com/go-playground/validator/v10
```

```go
import (
    "github.com/go-playground/validator/v10"
)
```

## Basic Usage

### Struct Tags

```go
type User struct {
    Name  string `validate:"required,min=2,max=100"`
    Email string `validate:"required,email"`
    Age   int    `validate:"gte=0,lte=150"`
}

// Validate
validate := validator.New()
err := validate.Struct(user)

if err != nil {
    // Handle validation errors
    for _, err := range err.(validator.ValidationErrors) {
        fmt.Printf("Field: %s, Tag: %s, Value: %v\n", err.Field(), err.Tag(), err.Value())
    }
}
```

### Variable Validation

```go
// Validate single variable
err := validate.Var(email, "required,email")
err := validate.Var(age, "gte=0,lte=150")
err := validate.Var(name, "required,min=2,max=100")

// Validate multiple variables
err := validate.VarWithValue(password, confirmPassword, "eqfield")
```

## Built-In Validators

### String Validators

| Tag                    | Description           |
| ---------------------- | --------------------- |
| `required`             | Not zero value        |
| `min=3`                | Minimum length        |
| `max=100`              | Maximum length        |
| `len=10`               | Exact length          |
| `email`                | Valid email format    |
| `url`                  | Valid URL             |
| `uri`                  | Valid URI             |
| `alpha`                | Letters only          |
| `alphanum`             | Letters and numbers   |
| `numeric`              | Numeric string        |
| `ascii`                | ASCII characters only |
| `lowercase`            | Lowercase only        |
| `uppercase`            | Uppercase only        |
| `contains=substring`   | Contains substring    |
| `startswith=prefix`    | Starts with prefix    |
| `endswith=suffix`      | Ends with suffix      |
| `oneof=red green blue` | One of the values     |
| `excludes=word`        | Does not contain word |
| `uuid`                 | Valid UUID            |
| `uuid4`                | Valid UUID v4         |

### Number Validators

| Tag           | Description             |
| ------------- | ----------------------- |
| `min=0`       | Minimum value           |
| `max=100`     | Maximum value           |
| `gte=0`       | Greater than or equal   |
| `gt=0`        | Greater than            |
| `lte=100`     | Less than or equal      |
| `lt=100`      | Less than               |
| `oneof=1 2 3` | One of the values       |
| `unique`      | Unique elements (slice) |

### Comparison Validators

| Tag                     | Description                |
| ----------------------- | -------------------------- |
| `eqfield=FieldName`     | Equal to another field     |
| `nefield=FieldName`     | Not equal to another field |
| `gtfield=FieldName`     | Greater than another field |
| `gtefield=FieldName`    | Greater than or equal      |
| `ltfield=FieldName`     | Less than another field    |
| `ltefield=FieldName`    | Less than or equal         |
| `eqcsfield=Inner.Field` | Equal to nested field      |
| `necsfield=Inner.Field` | Not equal to nested field  |

### Slice/Map Validators

```go
type Request struct {
    Tags    []string `validate:"required,min=1,max=10"`
    Scores  []int    `validate:"min=1,dive,gt=0"` // slice has 1+ items, each item > 0
    Config  map[string]string `validate:"required"`
}
```

### Struct-Level Validators

| Tag             | Description                      |
| --------------- | -------------------------------- |
| `structonly`    | Validate struct only, not fields |
| `nostructlevel` | Skip struct-level validation     |

## Nested Validation

### dive Tag

Validate elements within slices, maps, or nested structs:

```go
type Order struct {
    Items []Item `validate:"required,min=1,dive"` // Validate slice, then each element
}

type Item struct {
    ProductID string `validate:"required,uuid"`
    Quantity  int    `validate:"required,gt=0"`
}

// Map with dive
type Request struct {
    Headers map[string]string `validate:"dive,keys,min=1,endkeys,required"`
}
```

### Nested Structs

```go
type User struct {
    Name    string  `validate:"required"`
    Address Address `validate:"required"` // Address fields also validated
}

type Address struct {
    Street string `validate:"required"`
    City   string `validate:"required"`
}
```

## Cross-Field Validation

```go
type Registration struct {
    Password        string `validate:"required,min=8"`
    PasswordConfirm string `validate:"required,eqfield=Password"`
}

type DateRange struct {
    StartDate time.Time `validate:"required"`
    EndDate   time.Time `validate:"required,gtfield=StartDate"`
}
```

## Custom Validators

### Register Custom Validator

```go
validate := validator.New()

// Register custom validation function
validate.RegisterValidation("postal_code", func(fl validator.FieldLevel) bool {
    value := fl.Field().String()
    matched, _ := regexp.MatchString(`^\d{5}(-\d{4})?$`, value)
    return matched
})

// Usage
type Address struct {
    PostalCode string `validate:"required,postal_code"`
}
```

### Custom Validation with Parameters

```go
validate.RegisterValidation("prefix", func(fl validator.FieldLevel) bool {
    prefix := fl.Param() // Get parameter from tag
    value := fl.Field().String()
    return strings.HasPrefix(value, prefix)
})

// Usage
type Request struct {
    Code string `validate:"required,prefix=ORD-"` // Must start with "ORD-"
}
```

### Struct-Level Validation

For complex cross-field validation:

```go
type Registration struct {
    Password        string
    PasswordConfirm string
}

validate.RegisterStructValidation(func(sl validator.StructLevel) {
    reg := sl.Current().Interface().(Registration)
    if reg.Password != reg.PasswordConfirm {
        sl.ReportError(reg.PasswordConfirm, "PasswordConfirm", "PasswordConfirm", "eqfield", "")
    }
}, Registration{})
```

## Error Handling

### Parse Validation Errors

```go
import "errors"

err := validate.Struct(user)
if err != nil {
    // Use errors.As to safely handle both error types
    var validationErrors validator.ValidationErrors
    if errors.As(err, &validationErrors) {
        for _, e := range validationErrors {
            fmt.Printf("Field: %s\n", e.Field())
            fmt.Printf("Tag: %s\n", e.Tag())
            fmt.Printf("Param: %s\n", e.Param())
            fmt.Printf("Value: %v\n", e.Value())
            fmt.Printf("Error: %s\n", e.Error())
        }
    } else {
        // Handle *validator.InvalidValidationError or other errors
        fmt.Printf("Validation error: %v\n", err)
    }
}
```

### Custom Error Messages

```go
type ErrorResponse struct {
    Field   string `json:"field"`
    Message string `json:"message"`
}

func FormatErrors(err error) []ErrorResponse {
    var errs []ErrorResponse

    var validationErrors validator.ValidationErrors
    if !errors.As(err, &validationErrors) {
        // Not a validation error - return generic error
        return []ErrorResponse{{
            Field:   "",
            Message: err.Error(),
        }}
    }

    for _, e := range validationErrors {
        errs = append(errs, ErrorResponse{
            Field:   strings.ToLower(e.Field()),
            Message: getErrorMessage(e),
        })
    }

    return errs
}

func getErrorMessage(e validator.FieldError) string {
    switch e.Tag() {
    case "required":
        return fmt.Sprintf("%s is required", e.Field())
    case "email":
        return "Invalid email format"
    case "min":
        return fmt.Sprintf("%s must be at least %s characters", e.Field(), e.Param())
    case "max":
        return fmt.Sprintf("%s must be at most %s characters", e.Field(), e.Param())
    case "gtfield":
        return fmt.Sprintf("%s must be greater than %s", e.Field(), e.Param())
    default:
        return fmt.Sprintf("%s is invalid", e.Field())
    }
}
```

## Integration Patterns

### HTTP Handler Validation

```go
func (h *Handler) CreateUser(w http.ResponseWriter, r *http.Request) {
    var req CreateUserRequest
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        http.Error(w, "Invalid JSON", http.StatusBadRequest)
        return
    }

    if err := h.validate.Struct(req); err != nil {
        errors := FormatErrors(err)
        w.Header().Set("Content-Type", "application/json")
        w.WriteHeader(http.StatusBadRequest)
        json.NewEncoder(w).Encode(map[string]interface{}{
            "errors": errors,
        })
        return
    }

    // Process valid request
    // ...
}
```

### Middleware Validation

```go
// ValidateRequest accepts a factory function to create a fresh struct per request
func ValidateRequest(validate *validator.Validate, reqFactory func() interface{}) mux.MiddlewareFunc {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            // Create a fresh instance for each request
            req := reqFactory()

            if err := json.NewDecoder(r.Body).Decode(req); err != nil {
                respondWithError(w, http.StatusBadRequest, "Invalid JSON")
                return
            }

            if err := validate.Struct(req); err != nil {
                respondWithError(w, http.StatusBadRequest, FormatErrors(err))
                return
            }

            // Put validated request in context
            ctx := context.WithValue(r.Context(), "validatedRequest", req)
            next.ServeHTTP(w, r.WithContext(ctx))
        })
    }
}

// Usage:
// router.Use(ValidateRequest(validate, func() interface{} { return &CreateUserRequest{} }))
```

### Gin Integration

```go
import (
    "github.com/gin-gonic/gin/binding"
    "github.com/go-playground/validator/v10"
)

// In setup - get existing validator and register custom validations
if v, ok := binding.Validator.Engine().(*validator.Validate); ok {
    v.RegisterValidation("custom_tag", myValidationFunc)
}

// In handler
func (h *Handler) CreateUser(c *gin.Context) {
    var req CreateUserRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"errors": err.Error()})
        return
    }

    // Process valid request
    // ...
}
```
