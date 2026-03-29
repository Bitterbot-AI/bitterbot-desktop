import { type ComponentProps, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from './alert';
import { AlertTriangle } from 'lucide-react';

type Props = ComponentProps<typeof Button> & {
  pendingText?: string;
  errorMessage?: string;
};

export function SubmitButton({
  children,
  errorMessage,
  pendingText = 'Submitting...',
  disabled,
  ...props
}: Props) {
  const [pending, setPending] = useState(false);

  return (
    <div className="flex flex-col gap-y-4 w-full">
      {Boolean(errorMessage) && (
        <Alert variant="destructive" className="w-full">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}
      <div>
        <Button
          {...props}
          type="submit"
          disabled={disabled || pending}
        >
          {pending ? pendingText : children}
        </Button>
      </div>
    </div>
  );
}
